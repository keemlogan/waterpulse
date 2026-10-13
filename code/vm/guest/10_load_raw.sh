#!/bin/bash
# 10_load_raw.sh <묶음 tar 경로>
# 데이터 묶음(wp_sample_v1.tar, wp_full_*.tar)을 풀고 MANIFEST.tsv로 검증한 뒤 HDFS 원본 선반에 올린다.
# - 원본 JSON Lines는 고치지 않는다(파일마다 gzip만). Hive·Spark가 .gz를 그대로 읽는다.
# - 다시 실행해도 같은 결과(덮어쓰기). 검증이 하나라도 틀리면 HDFS에 올리지 않고 멈춘다.
# 환경: CDH 5.4.3 VM(CentOS 6.6, bash 4.1). 실행 계정 training.
set -eu
TAR=${1:?사용법: 10_load_raw.sh <묶음 tar 경로>}
NAME=$(basename "$TAR" .tar)
WORK=${WORK:-$HOME/waterpulse/data/$NAME}
HDFS_RAW=${HDFS_RAW:-/etl/waterpulse/raw}

echo "### CAPTURE: 묶음_풀기_${NAME}"
rm -rf "$WORK"; mkdir -p "$WORK"
tar -xf "$TAR" -C "$WORK"
cd "$WORK"
ls -la; du -sh .

echo "### CAPTURE: MANIFEST_검증_${NAME}"
# 묶음 v1의 MANIFEST는 칸 구분자가 탭 대신 글자 "\t"로 들어갔다(생성 스크립트 버그, 10/13). 두 형식 모두 읽는다.
sed -i 's/\\t/\t/g' MANIFEST.tsv
n=0; rows=0; bad=0
while IFS=$'\t' read -r f lines sha; do
  n=$((n + 1))
  got=$(zcat "$f" | wc -l)
  if [ "$got" != "$lines" ]; then echo "줄 수 불일치 $f: 압축 해제 $got / 기록 $lines"; bad=$((bad + 1)); fi
  s=$(sha256sum "$f" | cut -d' ' -f1)
  if [ "$s" != "$sha" ]; then echo "해시 불일치 $f"; bad=$((bad + 1)); fi
  rows=$((rows + lines))
done < MANIFEST.tsv
echo "검증 결과: 파일 $n개 · 원본 줄 합계 $rows · 불일치 $bad"
[ "$bad" -eq 0 ] || { echo "검증 실패 — HDFS에 올리지 않음"; exit 1; }

echo "### CAPTURE: HDFS_올리기_${NAME}"
# HDFS 루트(/)는 hdfs 계정 소유라 training이 /etl을 만들 수 없다 → 처음 한 번만 hdfs 계정으로 만들고 넘겨준다
if ! hdfs dfs -test -d /etl/waterpulse; then
  sudo -u hdfs hdfs dfs -mkdir -p /etl/waterpulse
  sudo -u hdfs hdfs dfs -chown -R training /etl /etl/waterpulse
fi
for ds in dam_hourly dam_daily rain_hourly level_hourly asos_hourly; do
  [ -d "$ds" ] || continue
  hdfs dfs -mkdir -p "$HDFS_RAW/$ds"
  hdfs dfs -put -f "$ds"/*.gz "$HDFS_RAW/$ds/"
done
# meta는 파일마다 폴더 하나(파일 하나 = Hive 표 하나)
if [ -d meta ]; then
  for f in meta/*.gz; do
    t=$(basename "$f" .jsonl.gz)
    hdfs dfs -mkdir -p "$HDFS_RAW/meta/$t"
    hdfs dfs -put -f "$f" "$HDFS_RAW/meta/$t/"
  done
fi
hdfs dfs -ls "$HDFS_RAW"
echo "--- 자료별 폴더·파일 수·바이트 (hdfs dfs -count)"
hdfs dfs -count "$HDFS_RAW"/*
echo "--- 용량 (hdfs dfs -du -h)"
hdfs dfs -du -h "$HDFS_RAW"

# 자료별 기대 줄 수 → Hive COUNT(*) 대조용
echo "### CAPTURE: 자료별_기대_행수_${NAME}"
awk -F'\t' '{split($1, p, "/"); c[p[1]] += $2} END {for (k in c) printf "%s\t%d\n", k, c[k]}' MANIFEST.tsv | sort | tee "$HOME/waterpulse/expected_rows_${NAME}.tsv"
echo "끝: $NAME"
