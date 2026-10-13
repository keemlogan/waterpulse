# WaterPulse progress monitor: pipeline log + guest Hive/YARN status (host-side filtering, no quoting issues)
$o='-o','BatchMode=yes','-o','ConnectTimeout=8','-o','HostKeyAlgorithms=+ssh-rsa','-o','PubkeyAcceptedAlgorithms=+ssh-rsa','-o','UserKnownHostsFile=E:\WaterPulse\tools\known_hosts','-i','E:\WaterPulse\keys\wp_vm_rsa'
"=== host $(Get-Date -f HH:mm:ss)"
Get-Content E:\WaterPulse\logs\48_pipeline.txt -Tail 6
$s = & ssh.exe -n @o training@192.168.38.129 'bash /tmp/guest_status.sh' 2>&1
$s | Select-String -Pattern '^=====|OK lines|FAILED|Exception|Stage-\d+ map|RUNNING\s|^application_' | Select-Object -Last 8 | ForEach-Object { $_.Line.Substring(0,[Math]::Min(170,$_.Line.Length)) }
"captures: " + ((Get-ChildItem E:\WaterPulse\captures\*.png | Sort-Object Name | Select-Object -Last 3).Name -join ', ')