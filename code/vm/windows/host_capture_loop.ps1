param(
    [int]$StartNo = 24,                 # first capture number
    [int]$TimeoutMin = 60
)
# Polls the guest for /tmp/wp_cap_req (written by guest_run_capture.sh), screenshots the VMware window,
# then deletes the request so the guest continues. Stops when /tmp/wp_cap_done appears.
$o = '-o','BatchMode=yes','-o','HostKeyAlgorithms=+ssh-rsa','-o','PubkeyAcceptedAlgorithms=+ssh-rsa',
     '-o','UserKnownHostsFile=E:\WaterPulse\tools\known_hosts','-i','E:\WaterPulse\keys\wp_vm_rsa'
$t = 'training@192.168.38.129'
$cap = 'E:\WaterPulse\tools\capture.ps1'
$no = $StartNo; $deadline = (Get-Date).AddMinutes($TimeoutMin)
while ((Get-Date) -lt $deadline) {
    $s = & ssh.exe @o $t 'if [ -e /tmp/wp_cap_req ]; then echo "REQ:$(cat /tmp/wp_cap_req)"; elif [ -e /tmp/wp_cap_done ]; then echo "DONE:$(cat /tmp/wp_cap_done)"; fi'
    if ($s -match '^REQ:(.+)$') {
        $name = ('{0:D2}_{1}' -f $no, $Matches[1].Trim()) -replace '[\\/:*?"<>|]', '_'
        Start-Sleep -Milliseconds 800
        & $cap -Name $name -WindowMatch '^vmware$' | Out-Null
        "$(Get-Date -f HH:mm:ss) captured $name"
        & ssh.exe @o $t 'rm -f /tmp/wp_cap_req'
        $no++
    } elseif ($s -match '^DONE:(.*)$') {
        "$(Get-Date -f HH:mm:ss) guest finished, exit=$($Matches[1])"
        break
    } else { Start-Sleep -Seconds 2 }
}
"next capture number: $no"
