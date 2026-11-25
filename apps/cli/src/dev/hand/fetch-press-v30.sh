#!/bin/zsh
# Hand film v30: press clips from source videos no earlier version used (zero template share), one per video,
# <= 6.5 s, muted, cropped clear of broadcaster graphics, 24 fps.
# usage: zsh apps/cli/src/dev/hand/fetch-press-v30.sh out/hand-ftx
J=${1:-out/hand-ftx}
D=$J/downloads/press
mkdir -p $D
clip() { # id start len crop name
  local tmp=$D/$5.part.mp4
  [[ -f $D/$5.mp4 ]] && return
  yt-dlp -q --no-warnings --no-playlist -f "bv*[height<=1080][ext=mp4]/bv*[height<=1080]" --download-sections "*$2-$(printf %.1f $(( $2 + $3 + 1 )))" -o $tmp "https://www.youtube.com/watch?v=$1"
  ffmpeg -v error -y -i $tmp -t $3 -an -vf "$4,scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=24,format=yuv420p" -c:v libx264 -crf 16 -preset medium $D/$5.mp4
  rm -f $tmp
}
clip weQm-4QgOrw 15 6 "crop=iw:ih:0:0" v30_nassau &
clip 9N7WO24aoT8 29.5 6 "crop=iw*0.8:ih*0.76:iw*0.1:0" v30_court_gma &
clip 0Hxf4Vf54PI 48 5.5 "crop=iw*0.7:ih*0.72:iw*0.15:0" v30_sbf_gma &
clip gN3jW4fhD70 18 6 "crop=iw*0.5:ih*0.64:iw*0.42:0" v30_cz_cnbc &
clip OrCHMpf2MqI 91 6 "crop=iw*0.72:ih*0.72:iw*0.14:ih*0.02" v30_ray_yahoo &
wait
ls -la $D | grep v30
