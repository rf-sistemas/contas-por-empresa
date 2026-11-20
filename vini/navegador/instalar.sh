#!/bin/bash
# SISTEMA MR - instalação do NAVEGADOR DO VINI na VPS (serviço "mr-navegador", separado do rf-navegador da RF)
# Uso (como root):  bash instalar.sh   (o arquivo .env com API e TOKEN tem que estar na mesma pasta deste script)
# Não mexe no Ravi, no rf-navegador, no estúdio nem no motor do Vini. Não abre porta.
set -u
AQUI="$(cd "$(dirname "$0")" && pwd)"
LOG=/var/log/mr-navegador-instalar.log
exec > >(tee -a $LOG) 2>&1
echo "== $(date) início"; free -m; df -h /
[ -f "$AQUI/.env" ] || { echo "FALTA o arquivo .env ao lado do script"; exit 1; }
[ -f "$AQUI/navegador.mjs" ] || { echo "FALTA o navegador.mjs ao lado do script"; exit 1; }
MEM=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
if [ "$MEM" -lt 900 ]; then echo "Memória livre só $MEM MB — NÃO instalei (precisa de 900 MB livres)"; exit 1; fi
N=$(command -v node || ls /usr/bin/node /usr/local/bin/node 2>/dev/null | head -1); NPM=$(command -v npm || echo "$(dirname "$N")/npm")
echo "node=$N $($N -v)"
id mrnav >/dev/null 2>&1 || useradd --system --home-dir /opt/mr-navegador --shell /usr/sbin/nologin mrnav
install -d -o mrnav -g mrnav -m 750 /opt/mr-navegador
install -o mrnav -g mrnav -m 640 "$AQUI/navegador.mjs" /opt/mr-navegador/navegador.mjs
printf '%s\n' '{"name":"mr-navegador","version":"1.0.0","private":true,"type":"module","dependencies":{"playwright":"1.49.1"}}' > /opt/mr-navegador/package.json
install -o mrnav -g mrnav -m 600 "$AQUI/.env" /opt/mr-navegador/.env
chown mrnav:mrnav /opt/mr-navegador/package.json
cd /opt/mr-navegador
runuser -u mrnav -- env HOME=/opt/mr-navegador PATH="$(dirname "$N"):$PATH" "$NPM" install --omit=dev --no-audit --no-fund || { echo "npm falhou"; exit 1; }
echo "== dependências do chromium (apt)"
DEBIAN_FRONTEND=noninteractive "$N" node_modules/playwright/cli.js install-deps chromium || echo "AVISO: install-deps falhou (provavelmente já instaladas pelo rf-navegador)"
echo "== chromium"
runuser -u mrnav -- env HOME=/opt/mr-navegador PLAYWRIGHT_BROWSERS_PATH=/opt/mr-navegador/browsers "$N" node_modules/playwright/cli.js install chromium || { echo "chromium falhou"; exit 1; }
cat > /etc/systemd/system/mr-navegador.service <<SVC
[Unit]
Description=Sistema MR - navegador do Vini (Chrome sem tela, isolado da RF)
After=network-online.target
Wants=network-online.target
[Service]
User=mrnav
Group=mrnav
WorkingDirectory=/opt/mr-navegador
Environment=HOME=/opt/mr-navegador
Environment=PLAYWRIGHT_BROWSERS_PATH=/opt/mr-navegador/browsers
ExecStart=$N /opt/mr-navegador/navegador.mjs
Restart=always
RestartSec=10
MemoryMax=1200M
CPUQuota=80%
Nice=10
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/opt/mr-navegador
[Install]
WantedBy=multi-user.target
SVC
systemctl daemon-reload; systemctl enable mr-navegador.service; systemctl restart mr-navegador.service
sleep 20
echo "mr-navegador=$(systemctl is-active mr-navegador) rf-navegador=$(systemctl is-active rf-navegador) ravi=$(systemctl is-active rf-ravi) vini=$(systemctl is-active vini) estudio=$(systemctl is-active rf-estudio)"
free -m; du -sh /opt/mr-navegador; journalctl -u mr-navegador -n 15 --no-pager
echo "== $(date) fim"
