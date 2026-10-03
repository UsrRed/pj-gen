# syntax=docker/dockerfile:1

# ── build : compile web/dist, installe toutes les deps (server tourne via tsx,
#    pas de compilation TS séparée nécessaire pour le serveur) ──────────────
FROM node:22-trixie-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci
COPY . .
RUN npm run build

# ── runtime : node_modules déjà construits, ajoute git (worktrees), gh et
#    claude (CLI headless piloté via l'abonnement OAuth, jamais de clé API) ──
FROM node:22-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl gnupg wget \
      python3 python3-pip python3-venv python-is-python3 \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app
COPY --from=builder /app /app

# Non-root : claude refuse --dangerously-skip-permissions sous uid 0, et toutes
# les sessions avec outils (scaffold, implement_task, analyse d'import…)
# échouaient. On tourne en `node` (uid 1000) mais on garde HOME=/root : les
# chemins absolus déjà en base (workspace_path), les worktrees git et les
# volumes montés sous /root restent valides. Les dossiers des volumes sont
# créés ici au bon propriétaire, qu'un volume neuf hérite à son premier montage.
RUN mkdir -p /root/.pj-gen /root/pj-workspace /root/.claude /root/.config/gh \
    && chown -R node:node /root
ENV HOME=/root
# Projets Python (ex. immo-paper : backend FastAPI, vérif `python -m pytest`) :
# sans interpréteur, chaque implement_task échouait sur « python: command not
# found ». pip s'installe dans le site utilisateur (~/.local, uid node) ;
# PEP 668 le refuse sur Debian sans ce drapeau — le conteneur est jetable.
# Base trixie (Python 3.13) : bookworm n'avait que 3.11, et immo-paper exige
# `requires-python >= 3.12` — son `pip install -e` ne pouvait pas aboutir.
# Le site utilisateur effectif est PYTHONUSERBASE (cf. toolEnv, volume de données).
ENV PIP_BREAK_SYSTEM_PACKAGES=1
USER node

ENV PJGEN_HOST=127.0.0.1
EXPOSE 80
CMD ["npm", "start"]
