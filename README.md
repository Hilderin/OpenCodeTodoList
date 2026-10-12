# OpenCodeTodoList

Réintroduire la **liste de tâches (todo)** d'OpenCode v1 dans **OpenCode v2** et
**OpenChamber**, au moyen d'un plugin OpenCode v2 et d'une extension OpenChamber.

## Contexte

OpenCode v2 a retiré les outils natifs `todowrite` / `todoread` et le panneau
todo associé. La décision est officielle (« we removed it because it slows agent
down »), mais l'issue a été réouverte et l'ajout d'un moyen de réactivation est
envisagé. En attendant, la fonctionnalité peut être réimplémentée hors du core,
via l'API plugin v2.

## Documentation

- [`docs/etude-technique.md`](docs/etude-technique.md) — étude technique : API
  plugin v2, contraintes, surface d'intégration OpenChamber, architecture
  proposée et plan de mise en œuvre.

## Statut

Étude technique en cours. Aucune implémentation pour l'instant.
