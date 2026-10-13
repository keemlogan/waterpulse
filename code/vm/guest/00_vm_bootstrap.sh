#!/bin/bash
# 00_vm_bootstrap.sh — 새로 푼 수업 VM을 WaterPulse 작업 상태로 만든다(실습실 PC가 매주 초기화되므로 한 번에 복구).
# 하는 일(몇 번을 다시 실행해도 같은 결과):
#   1) 데이터 디스크(/dev/sdb, 호스트가 vmx에 붙인 wp_data.vmdk)를 /data로 마운트 — 없으면 건너뜀
#   2) HDFS·YARN·Impala 작업 공간을 /data로 넓힘(설정 파일은 처음 한 번 .orig로 백업)
#   3) 서비스 켜기 + 부팅 때 자동 시작: HDFS·YARN·Hive 메타스토어·HiveServer2·Impala 3종·Hue
#   4) Hue 첫 계정 training/training(이미 있으면 건너뜀)
#   5) HDFS 작업 폴더(/etl/waterpulse, /data/waterpulse)
# 실행: sudo 없이 training 계정으로(필요한 곳만 sudo). 환경: CDH 5.4.3 VM(CentOS 6.6)
set -eu -o pipefail
log() { echo "[$(date '+%H:%M:%S')] $*"; }

# ── 1) 데이터 디스크 ──
if [ -b /dev/sdb ]; then
  if ! sudo blkid -L wpdata >/dev/null 2>&1; then
    log "새 디스크 /dev/sdb 파티션·포맷"
    if [ ! -b /dev/sdb1 ]; then printf 'o\nn\np\n1\n\n\nw\n' | sudo fdisk /dev/sdb >/dev/null 2>&1 || true; sudo partprobe /dev/sdb 2>/dev/null || true; sleep 2; fi
    sudo mkfs.ext4 -q -E lazy_itable_init=1,lazy_journal_init=1 -L wpdata /dev/sdb1   # 100GB 초기화를 뒤로 미뤄 약 4분 절약
  fi
  sudo mkdir -p /data
  grep -q 'LABEL=wpdata' /etc/fstab || echo 'LABEL=wpdata /data ext4 defaults 0 2' | sudo tee -a /etc/fstab >/dev/null
  mountpoint -q /data || sudo mount /data
  log "/data 마운트: $(df -h /data | tail -1)"
else
  log "데이터 디스크 없음(/dev/sdb) — 루트 디스크만 씀"
fi

# ── 2) 작업 공간을 /data로 ──
add_dir() {   # add_dir <xml 파일> <속성 이름> <덧붙일 값>
  local f=$1 name=$2 val=$3
  [ -f "$f.orig" ] || sudo cp "$f" "$f.orig"
  if ! grep -q "<name>$name</name>" "$f"; then
    # 속성이 없으면(기본값 사용 중) 새 디렉터리만 쓰는 속성을 추가
    sudo sed -i "s|</configuration>|  <property>\n    <name>$name</name>\n    <value>$val</value>\n  </property>\n</configuration>|" "$f"
    log "$name = $val (새 속성)"
  elif ! grep -A1 "<name>$name</name>" "$f" | grep -q "$val"; then
    sudo sed -i "/<name>$name<\/name>/{n;s|</value>|,$val</value>|}" "$f"
    log "$name += $val"
  fi
}
if mountpoint -q /data; then
  sudo mkdir -p /data/dfs/dn /data/yarn/local /data/yarn/logs /data/impala-scratch
  sudo chown -R hdfs:hdfs /data/dfs; sudo chmod 700 /data/dfs/dn
  sudo chown -R yarn:yarn /data/yarn
  sudo chown -R impala:impala /data/impala-scratch
  add_dir /etc/hadoop/conf/hdfs-site.xml dfs.datanode.data.dir file:///data/dfs/dn
  add_dir /etc/hadoop/conf/yarn-site.xml yarn.nodemanager.local-dirs /data/yarn/local
  add_dir /etc/hadoop/conf/yarn-site.xml yarn.nodemanager.log-dirs /data/yarn/logs
  [ -f /etc/default/impala.orig ] || sudo cp /etc/default/impala /etc/default/impala.orig
  grep -q 'scratch_dirs=/data/impala-scratch' /etc/default/impala || \
    sudo sed -i 's|^\(IMPALA_SERVER_ARGS=" *\\\)$|\1\n    -scratch_dirs=/data/impala-scratch \\|' /etc/default/impala
fi

# ── 3) 서비스 ──
# zookeeper-server: hive.support.concurrency=true라 ZooKeeper가 꺼져 있으면 Hive DDL이 끝없이 기다린다(10/13 실측)
SERVICES="zookeeper-server hadoop-hdfs-namenode hadoop-hdfs-datanode hadoop-yarn-resourcemanager hadoop-yarn-nodemanager hadoop-mapreduce-historyserver
          hive-metastore hive-server2 impala-state-store impala-catalog impala-server hue"
for s in $SERVICES; do
  [ -x /etc/init.d/$s ] || { log "서비스 없음: $s"; continue; }
  sudo chkconfig $s on
  sudo service $s restart >/dev/null 2>&1 || sudo service $s start >/dev/null 2>&1 || true
  log "$s: $(sudo service $s status 2>&1 | tail -1)"
done
sudo -u hdfs hdfs dfsadmin -safemode wait >/dev/null
log "HDFS: $(sudo -u hdfs hdfs dfsadmin -report 2>/dev/null | grep -m1 'Configured Capacity')"

# ── 3b) YARN 자원 · Hive 설정 ──
# 기본값은 컨테이너 2개라 map이 하나씩만 돈다. VM을 16GB · 4vCPU로 늘린 전제에서 YARN에 10GB · 8 vcores를 준다.
# (8vCPU는 CentOS 6이 부팅 중 멈춰서 쓰지 않음)
Y=/etc/hadoop/conf/yarn-site.xml
setprop() {
  if grep -q "<name>$1</name>" $Y; then sudo sed -i "/<name>$1<\/name>/{n;s#<value>.*</value>#<value>$2</value>#}" $Y
  else sudo sed -i "s#</configuration>#  <property>\n    <name>$1</name>\n    <value>$2</value>\n  </property>\n</configuration>#" $Y; fi
}
if ! grep -A1 'yarn.nodemanager.resource.memory-mb' $Y | grep -q 10240; then
  sudo cp -p $Y $Y.bak_yarnres_$(date +%Y%m%d_%H%M%S)
  setprop yarn.nodemanager.resource.memory-mb 10240
  setprop yarn.nodemanager.resource.cpu-vcores 8
  setprop yarn.scheduler.maximum-allocation-mb 10240
  sudo service hadoop-yarn-resourcemanager restart >/dev/null 2>&1; sudo service hadoop-yarn-nodemanager restart >/dev/null 2>&1
fi
# 작은 gz 파일이 많아(level 497개) map 수가 병목 → 단계 병렬 + 작은 파일 묶기
cat > ~/.hiverc <<'EOF'
set hive.exec.parallel=true;
set hive.exec.parallel.thread.number=6;
set hive.input.format=org.apache.hadoop.hive.ql.io.CombineHiveInputFormat;
set mapreduce.input.fileinputformat.split.maxsize=134217728;
set mapreduce.input.fileinputformat.split.minsize.per.node=67108864;
set mapreduce.input.fileinputformat.split.minsize.per.rack=67108864;
EOF
log "YARN: $(grep -A1 'yarn.nodemanager.resource.memory-mb' $Y | grep -o '<value>[0-9]*' | tr -d '<value>')MB"

# ── 4) Hue 첫 계정 ──
if ! sudo /usr/lib/hue/build/env/bin/hue shell >/dev/null 2>&1 <<'PY'
from django.contrib.auth.models import User
import sys
sys.exit(0 if User.objects.filter(username='training').exists() else 1)
PY
then
  sudo /usr/lib/hue/build/env/bin/hue shell >/dev/null 2>&1 <<'PY' || log "Hue 계정 자동 생성 실패 — windows/guest_hue_account.sh로 만들 것"
from django.contrib.auth.models import User
u = User.objects.create_user('training', password='training')
u.is_superuser = True
u.is_staff = True
u.save()
PY
fi
log "Hue 계정: training"

# ── 5) HDFS 작업 폴더 ──
sudo -u hdfs hdfs dfs -mkdir -p /etl/waterpulse/raw /data/waterpulse
sudo -u hdfs hdfs dfs -chown -R training /etl /etl/waterpulse /data/waterpulse
hdfs dfs -ls /etl/waterpulse /data
log "끝: VM 준비 완료"
