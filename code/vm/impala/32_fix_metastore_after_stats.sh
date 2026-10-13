#!/bin/bash
# 32_fix_metastore_after_stats.sh — Impala 2.2의 COMPUTE STATS 뒤처리.
# Impala 2.2는 파티션 표(clean_dam_hourly)의 파티션 InputFormat을 com.cloudera.impala.hive.serde.ParquetInputFormat으로 바꿔 쓴다.
# Hive 1.1은 이 클래스를 몰라 "Class not found"를 내고 ALTER도 거부한다(10/13 실측, 파티션 7개).
# 메타스토어 DB(MySQL)에서 그 행만 Hive의 Parquet 클래스로 되돌린다. 데이터 파일은 건드리지 않는다.
set -u
L=$HOME/waterpulse/logs; mkdir -p "$L"
H=/etc/hive/conf/hive-site.xml
val() { grep -A1 "<name>$1</name>" $H | grep -o '<value>[^<]*' | sed 's/<value>//'; }
URL=$(val javax.jdo.option.ConnectionURL); U=$(val javax.jdo.option.ConnectionUserName); P=$(val javax.jdo.option.ConnectionPassword)
DB=$(echo "$URL" | sed -E 's#.*://[^/]+/([^?]+).*#\1#')
M="mysql -u$U -p$P $DB -N -B -e"
WHERE="s.INPUT_FORMAT LIKE 'com.cloudera.impala%' OR s.OUTPUT_FORMAT LIKE 'com.cloudera.impala%' OR d.SLIB LIKE 'com.cloudera.impala%'"
BK=$L/metastore_sds_backup_$(date +%Y%m%d_%H%M%S).tsv
$M "SELECT s.SD_ID, s.INPUT_FORMAT, s.OUTPUT_FORMAT, d.SERDE_ID, d.SLIB FROM SDS s JOIN SERDES d ON s.SERDE_ID=d.SERDE_ID WHERE $WHERE" > "$BK"
n=$(wc -l < "$BK")
echo "Impala 전용 클래스가 들어간 저장 정보: ${n}행 (백업 $BK)"
[ "$n" -eq 0 ] && exit 0
$M "UPDATE SDS SET INPUT_FORMAT='org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat' WHERE INPUT_FORMAT LIKE 'com.cloudera.impala%';
    UPDATE SDS SET OUTPUT_FORMAT='org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat' WHERE OUTPUT_FORMAT LIKE 'com.cloudera.impala%';
    UPDATE SERDES SET SLIB='org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe' WHERE SLIB LIKE 'com.cloudera.impala%';"
echo "되돌린 뒤 남은 행: $($M "SELECT COUNT(*) FROM SDS s JOIN SERDES d ON s.SERDE_ID=d.SERDE_ID WHERE $WHERE")"
sudo service hive-metastore restart >/dev/null 2>&1; sudo service hive-server2 restart >/dev/null 2>&1; sleep 10
impala-shell -q "INVALIDATE METADATA wp.clean_dam_hourly" >/dev/null 2>&1
