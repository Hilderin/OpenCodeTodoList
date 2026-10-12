# OpenCodeTodoList

Réintroduire la **liste de tâches (todo)** retirée d'OpenCode v2, via des plugins.

## Contenu

| Répertoire | Rôle | Statut |
|---|---|---|
| [`opencode-plugin/`](opencode-plugin/) | Plugin OpenCode : outils `todowrite`/`todoread`, liste par session, anti-compaction | **implémenté** |
| [`openchamber-plugin/`](openchamber-plugin/) | Futur panneau / plugin OpenChamber | réservé |

## Contexte

OpenCode v2 a retiré les outils natifs `todowrite` / `todoread` et le panneau
todo associé (décision officielle pour raison de performance). La fonctionnalité
est réimplémentée ici hors du core, via l'API plugin v2.

## Démarrage rapide (plugin OpenCode)

Déclarer le dossier du plugin dans `opencode.jsonc` :

```jsonc
{
  "plugins": ["/home/guillaume/Documents/Projects/OpenCodeTodoList/opencode-plugin"]
}
```

Détails : [`opencode-plugin/README.md`](opencode-plugin/README.md).

## Documentation

- [`docs/etude-technique.md`](docs/etude-technique.md) — étude technique :
  historique de la suppression, API plugin v2, comparaison des approches
  (plugin / MCP / intégration OpenChamber), contraintes et décisions.
