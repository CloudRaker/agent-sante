# Agent Santé

[English](README.en.md)

Agent Santé aide les Québécois à trouver l'information santé officielle : où consulter, comment prendre
rendez-vous, vaccination, médicaments en vente libre, aînés, santé mentale et plus. Chaque réponse cite
sa source officielle et donne le lien. C'est un projet bénévole et libre de CloudRaker, à Montréal.
Ce n'est pas un service du gouvernement du Québec ni un service d'urgence.

Site : [agentsante.ca](https://agentsante.ca). Ce dépôt contient le site web : une application Vite +
React et une API Hono dans un seul Worker Cloudflare. Les agents (consignes et sources officielles) sont
dans [CloudRaker/agent-sante-agents](https://github.com/CloudRaker/agent-sante-agents).

## Comment ça fonctionne

1. La personne accepte les conditions dans la conversation. Une vérification anti-robot invisible
   (Cloudflare Turnstile) donne un jeton de session signé.
2. Chaque message passe un filtre de renseignements personnels (expressions régulières, puis
   Decision-machine-1, un modèle de CloudRaker hébergé à Montréal). Un message bloqué ne va jamais à un
   modèle de langue.
3. Le message va aux agents sur CloudRaker Run. La réponse est vérifiée (aucun conseil médical personnel)
   avant d'être affichée. Les citations du texte officiel sont vérifiées mot pour mot.
4. Les échanges sont effacés environ 10 minutes après la fin de la conversation. Le serveur n'enregistre
   jamais le texte des messages.

## Lancer le site en local

```sh
pnpm install
cp .dev.vars.example .dev.vars    # puis mettez une chaîne aléatoire dans SESSION_SECRET
pnpm dev                          # http://localhost:5173, avec de faux services Run et milliseconds
```

Vérifications : `pnpm check` (types, lint, tests et build).

## Documentation

La documentation technique est en anglais, dans [`docs/`](docs) :

- [Architecture](docs/architecture.md) : le parcours d'un message, les vérifications, le jeton de session
- [Flux d'activité](docs/activity-stream.md) : les étapes affichées pendant une réponse
- [Configuration](docs/configuration.md) : développement local, vérifications, réglages du Worker
- [Fonctionnalités](docs/features.md) : pages, affichage, messages vocaux, garde-fous, référencement
- [Outils des agents](docs/tools.md) : lieux, rendez-vous Clic Santé et médicaments
- [Citations](docs/citations.md) : citations du texte officiel et de la notice des médicaments
- [Agents](docs/agents.md) : catalogue, aiguillage direct, jeton Run
- [Coûts et statistiques](docs/analytics.md) : Analytics Engine, prix, requêtes SQL

Voir aussi [`ARC.md`](ARC.md) (composants Arc) et [`SECURITY.md`](SECURITY.md) (signaler un problème de
sécurité).

## Licence

Apache-2.0 (voir [`LICENSE`](LICENSE)). Les composants Arc de `src/components/arc` sont sous licence MIT.
