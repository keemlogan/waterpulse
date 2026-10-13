#!/bin/bash
# WaterPulse: Impala 2.2 wrote Impala-only class names into the Hive metastore (SDS/SERDES) for clean_dam_hourly partitions.
# Hive cannot read or ALTER them, so reset only those rows in the metastore DB (backup first). Data files untouched.
pkill -f run_step2_resume_rowcheck.sh; pkill -f guest_run_capture.sh
H=/etc/hive/conf/hive-site.xml
val() { grep -A1 "<name>$1</name>" $H | grep -o '<value>[^<]*' | sed 's/<value>//'; }
URL=$(val javax.jdo.option.ConnectionURL); U=$(val javax.jdo.option.ConnectionUserName); P=$(val javax.jdo.option.ConnectionPassword)
DB=$(echo "$URL" | sed -E 's#.*://[^/]+/([^?]+).*#\1#'); echo "metastore db=$DB user=$U"
M="mysql -u$U -p$P $DB -N -B -e"
echo "== before (backup: /tmp/wp_metastore_sds_backup.tsv)"
$M "SELECT s.SD_ID, s.INPUT_FORMAT, s.OUTPUT_FORMAT, d.SERDE_ID, d.SLIB FROM SDS s JOIN SERDES d ON s.SERDE_ID=d.SERDE_ID WHERE s.INPUT_FORMAT LIKE 'com.cloudera.impala%' OR s.OUTPUT_FORMAT LIKE 'com.cloudera.impala%' OR d.SLIB LIKE 'com.cloudera.impala%'" | tee /tmp/wp_metastore_sds_backup.tsv
echo "rows: $(wc -l < /tmp/wp_metastore_sds_backup.tsv)"
$M "UPDATE SDS SET INPUT_FORMAT='org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat' WHERE INPUT_FORMAT LIKE 'com.cloudera.impala%';
    UPDATE SDS SET OUTPUT_FORMAT='org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat' WHERE OUTPUT_FORMAT LIKE 'com.cloudera.impala%';
    UPDATE SERDES SET SLIB='org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe' WHERE SLIB LIKE 'com.cloudera.impala%';
    SELECT ROW_COUNT();"
echo "== after"
$M "SELECT COUNT(*) FROM SDS s JOIN SERDES d ON s.SERDE_ID=d.SERDE_ID WHERE s.INPUT_FORMAT LIKE 'com.cloudera.impala%' OR s.OUTPUT_FORMAT LIKE 'com.cloudera.impala%' OR d.SLIB LIKE 'com.cloudera.impala%'"
sudo service hive-metastore restart >/dev/null 2>&1; sudo service hive-server2 restart >/dev/null 2>&1; sleep 10
hive -e "SELECT damcode, ts, hidx, inflow FROM wp.clean_dam_hourly WHERE year = 2023 AND damcode = '1012110' AND ts = '2023-07-15 12:00'" 2>&1 | grep -E '^1012110|FAILED'
impala-shell -B -q "INVALIDATE METADATA wp.clean_dam_hourly; SELECT damcode, ts, hidx, inflow FROM wp.clean_dam_hourly WHERE year = 2023 AND damcode = '1012110' AND ts = '2023-07-15 12:00'" 2>&1 | grep -E '^1012110|ERROR'