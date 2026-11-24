#!/bin/zsh
# Hand-made film: one muted press clip per source video, <= 6.5 s, cropped clear of broadcaster graphics, 24 fps.
# usage: zsh apps/cli/src/dev/hand/fetch-press.sh out/hand-ftx
J=${1:-out/hand-ftx}
D=$J/downloads/press
mkdir -p $D
clip() { # id start len crop name
  local tmp=$D/$5.part.mp4
  [[ -f $D/$5.mp4 ]] && return
  yt-dlp -q --no-warnings --no-playlist -f "bv*[height<=1080][ext=mp4]/bv*[height<=1080]" --download-sections "*$2-$(printf %.1f $(( $2 + $3 + 1 )))" -o $tmp "https://www.youtube.com/watch?v=$1"
  local fit="scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080"
  [[ -n $CARD ]] && fit="scale=1800:-2"   # a card keeps its own shape (placed in a picture slot)
  ffmpeg -v error -y -i $tmp -t $3 -an -vf "$4,$fit,fps=24,format=yuv420p" -c:v libx264 -crf 16 -preset medium $D/$5.mp4
  rm -f $tmp
}
clip HOMA3RxhAPw 251.5 3.5 "crop=iw*0.62:ih*0.62:iw*0.12:0" sbf_bloomberg &
CARD=1 clip Pb4NR_MqhdM 78 3.5 "crop=iw*0.84:ih*0.40:iw*0.01:ih*0.28" tweet_cbs &
clip vZ5KTF0-Om0 82 5.5 "crop=iw:ih*0.84:0:0" sbf_court_nbc &
clip zEHgEiuniNY 236 6 "crop=iw*0.8:ih*0.8:iw*0.1:ih*0.05" ray_house &
clip rdHDShM_n_Q 100 5 "crop=iw*0.5:ih*0.5:iw*0.22:ih*0.02" cz_bloomberg &
clip Vr22nHBwFI8 4 6 "crop=iw:ih:0:0" court_scrum &
clip PMneW1ZxHSc 56 5.5 "crop=iw*0.7:ih*0.7:iw*0.15:0" sbf_cnbc &
wait
ls -la $D
