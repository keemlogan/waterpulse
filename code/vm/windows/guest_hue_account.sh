#!/bin/bash
# WaterPulse: create the first Hue superuser (training/training) via the first-login form, then check /user/training
OUT=/tmp/wp_hue_account.txt; : > $OUT
CJ=/tmp/wp_hue_cj.txt; rm -f $CJ
{
echo "===== GET /accounts/login/ ====="
curl -s -c $CJ -b $CJ -o /tmp/wp_login.html -w "http=%{http_code}\n" http://localhost:8888/accounts/login/
grep -o 'Create your Hue account' /tmp/wp_login.html | head -1
TOKEN=$(awk '$6=="csrftoken"{print $7}' $CJ)
echo "csrftoken_len=${#TOKEN}"
echo "===== POST first login (creates superuser) ====="
curl -s -c $CJ -b $CJ -o /dev/null -w "http=%{http_code} redirect=%{redirect_url}\n" \
  -e http://localhost:8888/accounts/login/ \
  --data-urlencode "username=training" --data-urlencode "password=training" \
  --data-urlencode "csrfmiddlewaretoken=$TOKEN" --data-urlencode "next=/" \
  http://localhost:8888/accounts/login/
echo "===== GET filebrowser /user/training (json) ====="
curl -s -b $CJ "http://localhost:8888/filebrowser/view/user/training?format=json" | head -c 600; echo
echo "===== hdfs dfs -ls /user ====="
hdfs dfs -ls /user
} >> $OUT 2>&1
