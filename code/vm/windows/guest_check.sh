#!/bin/bash
OUT=/tmp/wp_check.txt; : > $OUT
run() { echo "===== \$ $1 =====" >> $OUT; timeout 180 bash -lc "$1" >> $OUT 2>&1; echo "[exit=$?]" >> $OUT; }
run "hadoop version"
run "hive --version"
run "impala-shell --version"
run "spark-submit --version"
run "python --version"
run "mysql --version"
run "sqoop version"
run "flume-ng version"
run "df -h"
run "free -m"
run "nproc"
run "hdfs dfs -ls /"
run "ip addr show eth0"
run "hostname; cat /etc/redhat-release"
run "curl -s -o /dev/null -w 'hue_http=%{http_code}\n' http://localhost:8888/"
run "sudo service --status-all 2>/dev/null | egrep -i 'hadoop|hive|impala|hue|spark|sqoop|flume|mysql|sshd'"