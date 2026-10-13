#!/bin/bash
# WaterPulse: diagnose MANIFEST.tsv delimiter on a temp copy (does not touch the bundle or HDFS)
cd ~/waterpulse/data/wp_sample_v1 || exit 1
echo "real_tab_lines=$(grep -c $'\t' MANIFEST.tsv) literal_backslash_t_lines=$(grep -c '\\t' MANIFEST.tsv) total_lines=$(wc -l < MANIFEST.tsv)"
head -2 MANIFEST.tsv | cat -A | cut -c1-120
sed 's/\\t/\t/g' MANIFEST.tsv > /tmp/wp_manifest_fixed.tsv
n=0; rows=0; bad=0
while IFS=$'\t' read -r f lines sha; do
  n=$((n + 1)); got=$(zcat "$f" | wc -l)
  [ "$got" != "$lines" ] && { echo "줄 수 불일치 $f: $got / $lines"; bad=$((bad + 1)); }
  s=$(sha256sum "$f" | cut -d' ' -f1); [ "$s" != "$sha" ] && { echo "해시 불일치 $f"; bad=$((bad + 1)); }
  rows=$((rows + lines))
done < /tmp/wp_manifest_fixed.tsv
echo "진단(임시 사본, 탭 치환): 파일 $n개 · 원본 줄 합계 $rows · 불일치 $bad"
echo "--- 자료별 기대 행 수(진단용)"
awk -F'\t' '{split($1, p, "/"); c[p[1]] += $2} END {for (k in c) printf "%s\t%d\n", k, c[k]}' /tmp/wp_manifest_fixed.tsv | sort
