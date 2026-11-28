// The film agent's first stages, in its own process: research → script → narration (moved out of the old `produce`
// pipeline, 2026-11-28, so the one production path no longer runs or loads it). Outputs in the workspace, each cached:
// facts.json, script.draft.json (+ script.story.json), narration.mp3 / narration-shaped.mp3 and timed-script.json.
// Spend and seconds per stage go to timing.json ({ runs: [{ filmUsd, usd, seconds, stages }] }) and every Claude call to
// usage.json, so the film's limit counts them. A provider failure pauses where it is and resumes (senses/outside.ts).
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ZodType, ZodTypeDef } from "zod";
import { ChannelId, FactSheet, LicenseOverrides, ScriptDraft, TimedScript, type Aspect } from "@opumia/contracts";
import { analyseEscalations, buildStylePack, ensureReferenceFilms, ensureStoryBand, filmSpent, habitsOf, Ladders, lengthPlan, loadFingerprints, loadMemory, producedJobs, recentBlueprints, recordBlueprint, recordEscalations, researchAgent, researchTopic, resetClient, rewordForSpeech, setBudget, setCurrentStage, stageSpent, updateMemory, usageLedger, writeScript, type Problem, type Rung, type StoryReport } from "@opumia/agents";
import { calibrationKey, ensureVoiceMeasured, narrateDirected, readCalibration, recordNarrationPace, refitPauses, resolveChannelVoice, shapeColdOpen, storedVoiceMeasure, ttsModel as currentTtsModel, writeCalibration } from "@opumia/narration";
import { closeBrowser, pageTextViaBrowser, youtubeTranscript } from "@opumia/resolver";
import { PausedError, setPauseHooks } from "@opumia/senses";
import { loadKeys } from "../keys.js";

export interface StoryOptions {
  root: string; library: string; reference: string; data: string;
  topic: string; channel: string; aspect: Aspect; durationS: number;
  /** the workspace (out/<job>) */
  job: string;
  /** the whole film's spend limit (this stage counts against it) */
  maxUsd: number;
  log: (s: string) => void;
}

const exists = async (p: string) => Boolean(await stat(p).catch(() => null));
async function cached<T>(file: string, schema: ZodType<T, ZodTypeDef, unknown>, redo: boolean, make: () => Promise<T>, log: (s: string) => void): Promise<T> {
  if (!redo && (await exists(file))) {
    const parsed = schema.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (parsed.success) { log(`  ✓ ${path.basename(file)} (cached)`); return parsed.data; }
    log(`  ! ${path.basename(file)} failed validation; rebuilding`);
  }
  const v = schema.parse(await make());
  await writeFile(file, JSON.stringify(v, null, 2) + "\n");
  return v;
}

/** Research, script and narration for the film in `o.job` (cached stage by stage). */
export async function makeStory(o: StoryOptions): Promise<TimedScript> {
  const jobDir = o.job, jobId = path.basename(jobDir);
  await mkdir(jobDir, { recursive: true });
  const before = usageLedger().length;
  const spentBefore = await readFile(path.join(jobDir, "usage.json"), "utf8").then((t) => (JSON.parse(t) as { runs: Array<{ usd: number }> }).runs.reduce((a, r) => a + r.usd, 0), () => 0);
  setBudget(o.maxUsd, { spentBefore });
  const stages: Array<{ stage: string; seconds: number; usd: number }> = [];
  let open: { code: string; name: string; t: number } | null = null;
  const close = () => { if (!open) return; stages.push({ stage: `[${open.code}] ${open.name}`, seconds: Math.round((Date.now() - open.t) / 100) / 10, usd: Math.round(stageSpent(open.code) * 1e4) / 1e4 }); open = null; setCurrentStage(null); };
  const begin = (code: string, name: string) => { close(); open = { code, name, t: Date.now() }; setCurrentStage(code); o.log(`\n[${code}] ${name}`); };
  const pausedFile = path.join(jobDir, "paused.json");
  setPauseHooks({
    onPause: async (f, until) => {
      o.log(`  ⏸ PAUSED — ${f.provider}: ${f.kind}${f.status ? ` (HTTP ${f.status})` : ""}; trying again at ${until.replace("T", " ").slice(0, 16)} UTC (${f.message.slice(0, 120)})`);
      await writeFile(pausedFile, JSON.stringify({ at: new Date().toISOString(), stage: open?.code ?? null, provider: f.provider, kind: f.kind, status: f.status ?? null, until, message: f.message }, null, 2) + "\n");
    },
    onResume: async (f, waitedS) => {
      o.log(`  ▶ RESUMED — ${f.provider} answers again after ${Math.round(waitedS / 60)} min`);
      await appendFile(path.join(jobDir, "pauses.jsonl"), JSON.stringify({ at: new Date().toISOString(), stage: open?.code ?? null, provider: f.provider, kind: f.kind, waitedS: Math.round(waitedS) }) + "\n");
      await rm(pausedFile, { force: true });
    },
    // a key rotated in Keychain during the pause reaches this process
    reloadCredentials: () => (loadKeys(o.root), resetClient()),
  });
  try {
    const t = await stagesOf(o, begin);
    await rm(pausedFile, { force: true });
    return t;
  } catch (err) {
    if (err instanceof PausedError) await writeFile(pausedFile, JSON.stringify({ at: new Date().toISOString(), stage: (open as { code: string } | null)?.code ?? null, provider: err.failure.provider, kind: err.failure.kind, resumeAt: err.resumeAt, message: err.failure.message, resume: "run the same film-agent command again" }, null, 2) + "\n");
    throw err;
  } finally {
    close();
    setPauseHooks({});
    await closeBrowser().catch(() => {});
    await recordEscalations({ data: o.data, jobDir, job: jobId, channel: o.channel }).then(() => analyseEscalations({ data: o.data, channel: o.channel, log: o.log })).catch(() => null);
    const filmUsd = filmSpent();
    setBudget(null);
    if (stages.length) {
      const tf = path.join(jobDir, "timing.json");
      const prev = (await exists(tf)) ? (JSON.parse(await readFile(tf, "utf8")) as { runs: unknown[] }) : { runs: [] };
      prev.runs.push({ at: new Date().toISOString(), durationS: o.durationS, filmUsd: Math.round(filmUsd * 100) / 100, seconds: Math.round(stages.reduce((a, s) => a + s.seconds, 0)), usd: Math.round(stages.reduce((a, s) => a + s.usd, 0) * 1e4) / 1e4, stages });
      await writeFile(tf, JSON.stringify(prev, null, 2) + "\n").catch(() => {});
      o.log(`\nResearch, script and narration: $${filmUsd.toFixed(2)} so far — ${stages.map((s) => `${s.stage.split("]")[0]}] ${s.seconds.toFixed(0)} s $${s.usd.toFixed(2)}`).join(", ")}`);
    }
    const calls = usageLedger().slice(before);
    if (calls.length) {
      const file = path.join(jobDir, "usage.json");
      const prev = (await exists(file)) ? (JSON.parse(await readFile(file, "utf8")) as { runs: unknown[] }) : { runs: [] };
      prev.runs.push({ at: new Date().toISOString(), calls, usd: Math.round(calls.reduce((a, r) => a + r.usd, 0) * 1e4) / 1e4 });
      await writeFile(file, JSON.stringify(prev, null, 2) + "\n");
    }
  }
}

async function stagesOf(o: StoryOptions, begin: (code: string, name: string) => void): Promise<TimedScript> {
  const channel = ChannelId.parse(o.channel);
  const jobDir = o.job, jobId = path.basename(jobDir), log = o.log;
  await writeFile(path.join(jobDir, "job.json"), JSON.stringify({ topic: o.topic, channel, aspect: o.aspect, durationS: o.durationS }, null, 2) + "\n");
  const pack = await buildStylePack(channel, { reference: o.reference, data: o.data });
  const lp = lengthPlan(o.durationS);

  begin("A1", "research & fact-check");
  const facts = await cached(path.join(jobDir, "facts.json"), FactSheet, false, () => researchTopic({ topic: o.topic, format: o.durationS <= 120 ? `${o.durationS}-second ${o.aspect === "9:16" ? "vertical short" : "16:9 mini-documentary"}` : "long-form documentary", minClaims: lp.minClaims, memoryDir: path.join(o.data, "agents", "research"), browserRead: pageTextViaBrowser, videoTranscript: youtubeTranscript, log }), log);
  const producedSet = await producedJobs(o.data);
  const habits = habitsOf((await loadFingerprints(o.data)).filter((f) => f.job !== jobId).slice(-6));
  const memory = await loadMemory(o.data);

  begin("A2", "script");
  const voice = await resolveChannelVoice(channel, o.data, log);
  const ttsModel = currentTtsModel();
  const calKey = calibrationKey(voice, ttsModel);
  const calFile = await readCalibration(o.data);
  const cal = calFile as Record<string, { wpm: number; samples: number } | undefined>;
  const ovPath = path.join(o.data, "license-overrides.json");
  const overrides = (await exists(ovPath)) ? LicenseOverrides.parse(JSON.parse(await readFile(ovPath, "utf8"))) : null;
  const maxWpm = overrides?.channels[channel]?.maxWpm ?? Infinity;
  // The script is cut to the pace this voice naturally speaks at (owner: natural pace, never pushed). A voice the
  // platform has not met is measured once, before any script is written.
  const scriptCached = await exists(path.join(jobDir, "script.draft.json"));
  const narratorRef = await readFile(path.join(o.data, "exemplars", channel, "index.json"), "utf8").then((t) => (JSON.parse(t) as { narrator?: { prosody?: { melodySt?: { p25: number }; f0RangeSt?: { p25: number } } } }).narrator?.prosody, () => undefined);
  const natural = (await storedVoiceMeasure(o.data, voice.voiceId, ttsModel)) ?? (scriptCached ? null : await ensureVoiceMeasured({ dataDir: o.data, voice, modelId: ttsModel, ...(narratorRef?.melodySt && narratorRef.f0RangeSt ? { reference: { melodySt: narratorRef.melodySt.p25, pitchTravelSt: narratorRef.f0RangeSt.p25 } } : {}), log }));
  const narrationWpm = Math.round(Math.min(cal[calKey]?.wpm ?? natural?.wpm ?? 145, maxWpm));
  const narrationTargetS = o.durationS <= 120 ? o.durationS - 3 : o.durationS;
  const storyBand = await ensureStoryBand({ reference: o.reference, data: o.data, channelId: channel, log }).catch(() => null);
  const films = await ensureReferenceFilms({ reference: o.reference, data: o.data, channelId: channel }).catch(() => []);
  const memoryDir = path.join(o.data, "agents", "writer");
  const claimsBefore = facts.claims.length;
  const askResearcher = (questions: string[]) => researchAgent({ topic: o.topic, format: "", want: 0, questions, idStart: facts.claims.length, browserRead: pageTextViaBrowser, videoTranscript: youtubeTranscript, log }).then((r) => r.claims);
  const storyFile = path.join(jobDir, "script.story.json");
  const onStory = (r: StoryReport) => void writeFile(storyFile, JSON.stringify(r, null, 2) + "\n");
  const write = (brief?: string, wpm = narrationWpm) => writeScript({ ...(brief ? { brief } : {}), pack, facts, recentOpenings: habits.openings, aspect: o.aspect, durationS: narrationTargetS, narrationWpm: wpm, recent: recentBlueprints(memory, channel, 4, producedSet), storyBand, films, memoryDir, askResearcher, onStory, log });
  let draft = await cached(path.join(jobDir, "script.draft.json"), ScriptDraft, false, () => write(), log);
  log(`  "${draft.title}" — ${draft.wordCount} words at ${narrationWpm} wpm (${cal[calKey] ? "calibrated" : "default"})`);
  if (draft.blueprint) await updateMemory(o.data, (m) => recordBlueprint(m, channel, { job: jobId, hook: draft.blueprint!.hook, ending: draft.blueprint!.ending, spine: draft.blueprint!.spine, ...(draft.blueprint!.beats?.length ? { beats: draft.blueprint!.beats } : {}) }));
  {
    const st = await readFile(storyFile, "utf8").then((t) => JSON.parse(t) as StoryReport, () => null);
    if (st && !st.pass) log(`  ! the script misses the channel's story band (${st.remaining.map((x) => x.kind).join(", ")}) — narrated anyway (script.story.json)`);
  }
  if (facts.claims.length > claimsBefore) {
    await writeFile(path.join(jobDir, "facts.json"), JSON.stringify(facts, null, 2) + "\n");
    log(`  writer: asked the researcher — ${facts.claims.length - claimsBefore} verified fact(s) added to the fact sheet`);
  }

  begin("A3", "narration (ElevenLabs)");
  const timedPath = path.join(jobDir, "timed-script.json");
  let fresh = false;
  const doNarrate = async () => {
    fresh = true;
    // directed narration: voice director → line takes → listen-back → retakes; the voice's speed is never touched
    const nar = await readFile(path.join(o.data, "exemplars", channel, "index.json"), "utf8").then((t) => (JSON.parse(t) as { narrator?: { wpm: { p25: number; p50: number }; prosody?: { f0RangeSt?: { p50: number }; melodySt?: { p50: number } } } }).narrator, () => undefined);
    const reword = async (x: { text: string; why: string; context: string }) => rewordForSpeech({ text: x.text, why: x.why, context: x.context, facts: facts.claims.filter((c) => c.verdict === "supported" || c.verdict === "partially_supported").map((c) => c.text) }).catch(() => null);
    const res = await narrateDirected({ draft, facts, outDir: jobDir, dataDir: o.data, channel, voice, modelId: ttsModel, libraryDir: o.library, reword, ears: { root: o.root }, ...(nar ? { narrator: { wpm: nar.wpm.p50, wpmLow: nar.wpm.p25, ...(nar.prosody?.f0RangeSt ? { f0RangeSt: nar.prosody.f0RangeSt.p50 } : {}), ...(nar.prosody?.melodySt ? { melodySt: nar.prosody.melodySt.p50 } : {}) } } : {}), log });
    if (res.report.unresolved.length) log(`  ! narration has ${res.report.unresolved.length} unresolved line(s): ${res.report.unresolved.slice(0, 3).join("; ")}`);
    if (res.draft && JSON.stringify(res.draft.segments.map((sg) => sg.text)) !== JSON.stringify(draft.segments.map((sg) => sg.text))) {
      draft = ScriptDraft.parse(res.draft);
      await writeFile(path.join(jobDir, "script.draft.json"), JSON.stringify(draft, null, 2) + "\n");
      log("  narration: the script as spoken was saved (lines re-set or reworded for speech)");
    }
    if (res.report.names?.unsolved.length) log(`  ! names not yet said right: ${res.report.names.unsolved.join(", ")}`);
    const ws = res.script.segments.flatMap((sg) => sg.words);
    const span = (ws.at(-1)?.endS ?? 0) - (ws[0]?.startS ?? 0);
    if (span > 10) await recordNarrationPace(o.data, voice.voiceId, ttsModel, (ws.length / span) * 60);
    return res.script;
  };
  let timed = await cached(timedPath, TimedScript, false, doNarrate, log);
  const paceOf = (t: TimedScript) => (t.segments.reduce((n, sg) => n + sg.words.length, 0) / Math.max(1, (t.segments.at(-1)?.endS ?? t.durationS) - (t.segments[0]?.startS ?? 0))) * 60;
  const recordCalibration = async (t: TimedScript) => {
    const wpm = paceOf(t), prev = cal[calKey];
    cal[calKey] = prev ? { wpm: Math.round(((prev.wpm * prev.samples + wpm) / (prev.samples + 1)) * 10) / 10, samples: prev.samples + 1 } : { wpm: Math.round(wpm * 10) / 10, samples: 1 };
    await writeCalibration(o.data, calFile);
  };
  // fit window: a short lands within [duration − 8 s, duration − 1 s]; a long film within about ±9 %
  const maxS = o.durationS <= 120 ? o.durationS - 1 : o.durationS * 1.08;
  const minS = o.durationS - Math.max(3, o.durationS * 0.09);
  if (fresh) await recordCalibration(timed);
  // Length is fitted inside the pauses first (no new take), then by the writer re-wording; lines the voice could not
  // say cleanly after retakes, and names still wrong, are reworded for speech. The voice's speed is never touched.
  {
    type VoiceAct = { note: string[] };
    type Report = { unresolved?: string[]; deliveryUnresolved?: string[]; names?: { unsolved: string[] } };
    const readReport = async () => await readFile(path.join(jobDir, "narration.report.json"), "utf8").then((t) => JSON.parse(t) as Report, () => ({}) as Report);
    const mid = (minS + maxS) / 2;
    const rewriteFor = async (brief: string) => {
      draft = await cached(path.join(jobDir, "script.draft.json"), ScriptDraft, true, () => write(brief, Math.floor(paceOf(timed) * 0.98)), log);
      timed = await cached(timedPath, TimedScript, true, doNarrate, log);
      await recordCalibration(timed);
      return `${draft.wordCount} words → ${timed.durationS.toFixed(1)} s`;
    };
    const wordsOff = () => Math.round(((timed.durationS - mid) * paceOf(timed)) / 60);
    const lengthLadder: Array<Rung<VoiceAct>> = [
      { name: "pauses adjusted inside the silence", owner: "voice director", maxUsd: 0, run: async () => {
        const pauseTotal = timed.segments.flatMap((sg) => sg.words).reduce((t, w, k, ws) => (k + 1 < ws.length && /[.?!]["”')\]]*$/.test(w.word) ? t + Math.max(0, ws[k + 1]!.startS - w.endS) : t), 0);
        if (pauseTotal < 0.5) return null;
        const scale = Math.max(0.5, Math.min(2.2, 1 + (mid - timed.durationS) / pauseTotal));
        const r = await refitPauses(timed, scale, path.join(jobDir, "narration.mp3"));
        timed = r.script;
        await writeFile(timedPath, JSON.stringify(timed, null, 2) + "\n");
        return `${r.pauses} pause(s) ×${scale.toFixed(2)}: ${r.before.toFixed(1)} → ${r.after.toFixed(1)} s`;
      } },
      { name: "the writer trims or extends a sentence", owner: "writer", maxUsd: 0.6, run: async () => rewriteFor(`The narration runs ${timed.durationS.toFixed(1)} s; it must land between ${minS} and ${maxS} s. ${wordsOff() > 0 ? `Cut about ${wordsOff()} words` : `Add about ${-wordsOff()} words`} — trim or extend sentences, keep the story and every verified fact.`) },
      { name: "the writer again, with the exact word count", owner: "writer", maxUsd: 0.6, run: async () => rewriteFor(`Still ${timed.durationS.toFixed(1)} s against ${minS}–${maxS} s at the voice's measured ${paceOf(timed).toFixed(0)} wpm: the script must be ${Math.round((mid * paceOf(timed)) / 60)} words (it is ${timed.segments.reduce((n, sg) => n + sg.words.length, 0)}).`) },
    ];
    const wordsLadder: Array<Rung<VoiceAct>> = [1, 2].map((k) => ({ name: k === 1 ? "the writer rewords the lines the voice could not say" : "the writer rewords them again, more plainly", owner: "writer", maxUsd: 0.6, run: async () => { const un = (await readReport()).unresolved ?? []; return un.length ? rewriteFor(`After retakes and respellings these lines still were not said cleanly: ${un.slice(0, 8).map((x) => `"${x}"`).join("; ")}. Reword them ${k === 2 ? "in the plainest words, avoiding the names or terms that fail" : ""} (same facts).`) : null; } }));
    const deliveryLadder: Array<Rung<VoiceAct>> = [{ name: "the writer rewords the lines whose delivery stayed wrong", owner: "writer", maxUsd: 0.6, run: async () => {
      const rp = await readReport();
      const left = [...(rp.deliveryUnresolved ?? []), ...(rp.names?.unsolved ?? []).map((n) => `the name "${n}" is not said right`)];
      return left.length ? rewriteFor(`The narration's delivery is still wrong after the voice director's retakes: ${left.slice(0, 8).join("; ")}. Reword those lines so a narrator says them naturally — statements that end falling, the stressed word where the sentence lands, no break where a speaker would run on${rp.names?.unsolved.length ? "; where a name keeps failing, say it once in full and then use the person's role" : ""} (same facts, same length).`) : null;
    } }];
    const ladders = new Ladders<VoiceAct>({ jobDir, stage: "narration", table: { narration_length: lengthLadder, voice_unresolved: wordsLadder, voice_delivery: deliveryLadder }, log });
    let problems: Problem[] = [];
    for (let round = 0; round < 5; round++) {
      const rp = await readReport(), un = rp.unresolved ?? [];
      const nDel = (rp.deliveryUnresolved?.length ?? 0) + (rp.names?.unsolved.length ?? 0);
      problems = [
        ...(timed.durationS > maxS || timed.durationS < minS ? [{ check: "narration_length", shots: [], what: "narration outside the length window", measured: `${timed.durationS.toFixed(1)} s`, band: `${minS}–${maxS} s` }] : []),
        ...(un.length >= 2 ? [{ check: "voice_unresolved", shots: [], what: `${un.length} line(s) not said cleanly after retakes`, measured: String(un.length), band: "0" }] : []),
        ...(nDel ? [{ check: "voice_delivery", shots: [], what: `${nDel} delivery problem(s) or name(s) still wrong after retakes`, measured: String(nDel), band: "0" }] : []),
      ];
      if (!problems.length) break;
      if (!(await ladders.step(problems, { note: [] })).length) break;
    }
    await ladders.close(problems);
  }
  if (timed.durationS > maxS || timed.durationS < minS) log(`  ! narration runs ${timed.durationS.toFixed(1)} s against ${minS}–${maxS} s — kept at its natural pace (ladders.jsonl)`);
  // the channel's cold open: no dead air between lines (pauses capped at 0.6 s); a film long enough for chapters gets a
  // 2 s breath after the hook for its title card
  if (!/narration-shaped\.mp3$/.test(timed.voice.audioPath)) {
    const hook = [...timed.segments].reverse().find((sg) => sg.role === "hook");
    const longForm = lengthPlan(timed.durationS).chapters > 0;
    const sh = await shapeColdOpen(timed, { capS: 0.6, ...(longForm && hook && hook !== timed.segments.at(-1) ? { breathAfterSeg: hook.id, breathS: 2 } : {}) }, path.join(jobDir, "narration-shaped.mp3"));
    timed = TimedScript.parse({ ...sh.script, ...(sh.breath ? { titleCard: sh.breath } : {}) });
    await writeFile(timedPath, JSON.stringify(timed, null, 2) + "\n");
    log(`  cold open: ${sh.pauses} pause(s) reshaped${sh.breath ? `; title breath ${sh.breath.startS}–${sh.breath.endS} s` : ""}`);
  }
  log(`  narration ${timed.durationS.toFixed(2)} s, ${timed.segments.length} segments`);
  return timed;
}
