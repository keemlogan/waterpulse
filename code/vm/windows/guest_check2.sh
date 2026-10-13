#!/bin/bash
OUT=/tmp/wp_check2.txt; : > $OUT
run() { echo "===== \$ $1 =====" >> $OUT; timeout 60 bash -lc "$1" >> $OUT 2>&1; echo "[exit=$?]" >> $OUT; }
run "rpm -qa | egrep -i '^hue' ; ls /etc/init.d/ | egrep -i 'hue|ssh'"
run "sudo service sshd status; sudo chkconfig --list sshd"
run "sudo netstat -tlnp | egrep ':22 |:8888 |:8088 |:50070 |:3306 |:10000 '"
run "cat ~/Desktop/*.txt 2>/dev/null | head -50; ls ~ ~/Desktop"