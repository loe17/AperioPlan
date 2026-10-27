# Caddy mit Erweiterung für den DNS-Anbieter – nur nötig für Let's Encrypt im lokalen Netz
# (install.sh, Option 2). Der Anbieter wird über DNS_PROVIDER in .env gewählt.
FROM caddy:2-builder AS build
ARG DNS_PROVIDER=duckdns
RUN xcaddy build --with github.com/caddy-dns/${DNS_PROVIDER}

FROM caddy:2-alpine
COPY --from=build /usr/bin/caddy /usr/bin/caddy
