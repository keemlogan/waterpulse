#!/bin/bash
# WaterPulse: start Hive/Impala services, enable at boot, verify, dump hadoop config
OUT=/tmp/wp_services.txt; : > $OUT
run() { echo "===== \$ $1 =====" >> $OUT; timeout 300 bash -lc "$1" >> $OUT 2>&1; echo "[exit=$?]" >> $OUT; }
STATUS="sudo service --status-all 2>/dev/null | egrep -i 'hadoop|hive|impala|hue|spark|mysql|sshd'"

run "$STATUS"
for s in hive-metastore hive-server2 impala-state-store impala-catalog impala-server; do
  run "sudo service $s start"
  run "sudo chkconfig $s on"
  sleep 5
done
sleep 20
run "sudo chkconfig --list | egrep 'hive|impala|hue|hadoop'"
run "$STATUS"
run "beeline -u jdbc:hive2://localhost:10000 -n training -e 'show databases;'"
run "hive -e 'show databases;'"
run "impala-shell -q 'show databases;'"

# hadoop config
run "grep -A2 -E 'dfs.replication|dfs.datanode.data.dir' /etc/hadoop/conf/hdfs-site.xml"
run "sudo -u hdfs hdfs dfsadmin -report"
run "date; date -u; cat /etc/sysconfig/clock; ls -l /etc/localtime"
run "ls -l /usr/lib/hive-hcatalog/share/hcatalog/ | grep -i 'hive-hcatalog-core'"
