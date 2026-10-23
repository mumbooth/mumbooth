#!/usr/bin/env bash
# One-time VPS setup for MUMBOOTH (idempotent; re-run to apply a changed nginx.conf / headers / unit — the port is remembered from
# the installed unit). Creates: user `mumbooth`, /srv/mumbooth/{web,server}, /var/lib/mumbooth (0700), /etc/mumbooth.env (root 0600,
# template with placeholders), systemd unit, nginx site + shared conf files. It does NOT start the service (deploy.sh does) and does
# NOT run certbot unless the domain already resolves to this host.
#   PORT=4930 ./deploy/provision.sh        first check what is free:  ssh us1 'ss -ltnp'
# Env: HOST (default .deploy-host or us1) · DOMAIN (default .deploy-domain or mumbooth.chat) · PORT (default 4930)
#      CERTBOT_EMAIL (optional) · CERTBOT_ACCOUNT (us1 has two ACME accounts; projects from 182 on use 0b69…)
# The lead runs this. Agents never do.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${HOST:-$(cat .deploy-host 2>/dev/null || echo us1)}
DOMAIN=${DOMAIN:-$(cat .deploy-domain 2>/dev/null || echo mumbooth.chat)}
PORT=${PORT:-4930}

scp -q deploy/mumbooth.service "$HOST:/tmp/mumbooth.service.tpl"
scp -q deploy/nginx.conf "$HOST:/tmp/mumbooth.nginx.tpl"
scp -q deploy/mumbooth-proxy.conf "$HOST:/etc/nginx/mumbooth-proxy.conf"
scp -q deploy/mumbooth-headers.conf "$HOST:/etc/nginx/mumbooth-headers.conf"
scp -q deploy/mumbooth-limits.conf "$HOST:/etc/nginx/conf.d/mumbooth-limits.conf"

ssh "$HOST" PORT="$PORT" DOMAIN="$DOMAIN" CERTBOT_EMAIL="${CERTBOT_EMAIL:-}" CERTBOT_ACCOUNT="${CERTBOT_ACCOUNT:-}" bash -s <<'REMOTE'
set -euo pipefail
command -v node >/dev/null || { echo "✗ node missing on the VPS"; exit 1; }
node -e 'require("node:sqlite")' 2>/dev/null || { echo "✗ this node has no node:sqlite (need >= 22.13)"; exit 1; }
command -v npm >/dev/null || { echo "✗ npm missing"; exit 1; }
command -v nginx >/dev/null || { echo "✗ nginx missing"; exit 1; }

id mumbooth >/dev/null 2>&1 || useradd --system --home /srv/mumbooth --shell /usr/sbin/nologin mumbooth
mkdir -p /srv/mumbooth/web /srv/mumbooth/server /var/www/html/.well-known/acme-challenge
install -d -o mumbooth -g mumbooth -m 0700 /var/lib/mumbooth

# ---- port: ours if the unit already has one, else $PORT must be free ----
taken() { ss -ltnH "( sport = :$1 )" | grep -q .; }
CUR=$(sed -n 's/^Environment=PORT=//p' /etc/systemd/system/mumbooth.service 2>/dev/null || true)
if [ -n "$CUR" ] && [ "$CUR" != "PORT_PLACEHOLDER" ]; then PORT=$CUR
elif taken "$PORT"; then echo "✗ port $PORT is taken on the VPS — pick another: PORT=… ./deploy/provision.sh"; ss -ltnp | head -40; exit 1
fi
echo "→ port $PORT · domain $DOMAIN"

# ---- env file (never overwritten once it exists). Empty TOKENS_PER_COUPON / HOLD_MIN = not launched; golive.sh fills them. ----
if [ ! -f /etc/mumbooth.env ]; then
  ( umask 077
    cat > /etc/mumbooth.env <<ENV
PORT=$PORT
ANTHROPIC_API_KEY=sk-ant-PUT_THE_MUMBOOTH_KEY_HERE
TREASURY=0xPUT_THE_TREASURY_ADDRESS_HERE
PRICE_WEI=20000000000000
MAX_PACK=500
HOLD_PER_DAY=5
HOLD_MIN=
TOKENS_PER_COUPON=
TRIAL_DAILY_CAP=1500
DATA_DIR=/var/lib/mumbooth
TOKEN_JSON=/srv/mumbooth/web/token.json
RPC_URL=https://robinhood-rpc.publicnode.com
TRUST_PROXY=1
ENV
  )
  chown root:root /etc/mumbooth.env; chmod 600 /etc/mumbooth.env
  echo "→ created /etc/mumbooth.env: put the real ANTHROPIC_API_KEY and TREASURY in it (nano /etc/mumbooth.env) before the first start"
fi

# ---- systemd unit ----
sed "s/PORT_PLACEHOLDER/$PORT/g" /tmp/mumbooth.service.tpl > /etc/systemd/system/mumbooth.service
systemctl daemon-reload
systemctl enable mumbooth >/dev/null 2>&1 || true

# ---- nginx site (HTTP first) ----
SITE=/etc/nginx/sites-available/mumbooth
[ -f "$SITE" ] && cp -f "$SITE" "$SITE.bak"
sed -e "s/PORT_PLACEHOLDER/$PORT/g" -e "s/mumbooth\.chat/$DOMAIN/g" /tmp/mumbooth.nginx.tpl > "$SITE"
ln -sf "$SITE" /etc/nginx/sites-enabled/mumbooth
if nginx -t; then systemctl reload nginx; echo "✓ nginx reloaded with the mumbooth site (HTTP)"
else
  echo "✗ nginx -t failed — restoring the previous site"; if [ -f "$SITE.bak" ]; then mv -f "$SITE.bak" "$SITE"; else rm -f /etc/nginx/sites-enabled/mumbooth; fi; nginx -t && systemctl reload nginx; exit 1
fi

# ---- TLS: only when DNS already points here ----
if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  certbot install --cert-name "$DOMAIN" --nginx --redirect --non-interactive && echo "✓ existing certificate re-applied to the site"
else
  RESOLVED=$(getent ahostsv4 "$DOMAIN" | awk '{print $1; exit}' || true)
  if [ -n "$RESOLVED" ] && hostname -I | tr ' ' '\n' | grep -qx "$RESOLVED"; then
    command -v certbot >/dev/null || { echo "✗ certbot missing (apt install certbot python3-certbot-nginx)"; exit 1; }
    if [ -n "$CERTBOT_EMAIL" ]; then EMAIL=(-m "$CERTBOT_EMAIL"); else EMAIL=(--register-unsafely-without-email); fi
    if [ -n "$CERTBOT_ACCOUNT" ]; then ACCT=(--account "$CERTBOT_ACCOUNT"); else ACCT=(); fi
    certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --redirect --non-interactive --agree-tos "${EMAIL[@]}" "${ACCT[@]}"
    echo "✓ certificate for $DOMAIN + www"
  else
    echo "⚠ $DOMAIN does not resolve to this host yet (got: ${RESOLVED:-nothing}) — skipped certbot. Point DNS A @ and www here, then re-run."
  fi
fi
rm -f /tmp/mumbooth.service.tpl /tmp/mumbooth.nginx.tpl
REMOTE
echo "→ provisioned. Next: set ANTHROPIC_API_KEY + TREASURY in /etc/mumbooth.env on the server, then ./deploy.sh. After the FIRST start copy /var/lib/mumbooth/keys/ to secrets/ (0600)."
