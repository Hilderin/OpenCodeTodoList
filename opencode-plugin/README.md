# opencode-plugin

Un petit **plugin OpenCode v2** qui restaure les outils `todowrite` / `todoread`
et la liste de tâches de session, retirés d'OpenCode v2.

- **Outils natifs** `todowrite` (créer/remplacer la liste) et `todoread` (relire),
  directs (pas derrière le Code Mode `execute`).
- **Persistance** par session via `ctx.storage` (le KV durable du plugin) : pas
  de fichier à gérer, pas d'accès à la base de données.
- **Survit à la compaction** : la liste des tâches ouvertes est réinjectée dans
  chaque requête modèle via `ctx.session.hook("context")`.
- **Aucun process séparé**, aucune config MCP, aucune modification d'OpenCode ni
  d'OpenChamber.

> Contexte et comparaison des approches : [`../docs/etude-technique.md`](../docs/etude-technique.md).

## Installation

Le plugin doit être chargé comme un **répertoire** (OpenCode résout son
`index.js`). Deux méthodes.

### 1. Déclarer le dossier dans la config (recommandé)

Dans `opencode.jsonc`, au niveau global (`~/.config/opencode/opencode.jsonc`) ou
projet :

```jsonc
{
  "plugins": ["/home/guillaume/Documents/Projects/OpenCodeTodoList/opencode-plugin"]
}
```

Redémarrer le serveur OpenCode (ou recharger la config). Le plugin est
hot-rechargé à chaque modification de `index.js`.

### 2. Copier dans le dossier de plugins du projet

Copier ce dossier sous `.opencode/plugins/todolist/` (un **répertoire**, avec
`index.js` à sa racine) :

```
.opencode/plugins/todolist/
├── package.json
└── index.js
```

### Vérifier le chargement

```sh
opencode api get /api/plugin
```

Le plugin doit apparaître avec `"id": "todolist"` et `"state": { "status": "active" }`.

## Utilisation

Le modèle appelle `todowrite` avec la liste complète à chaque changement :

```json
{ "todos": [
  { "content": "Lire la spec", "status": "completed", "priority": "high" },
  { "content": "Écrire la migration", "status": "in_progress", "priority": "high" },
  { "content": "Ajouter les tests", "status": "pending", "priority": "medium" }
] }
```

`todoread` renvoie la liste courante. Les tâches ouvertes sont automatiquement
rappelées au modèle avant chaque appel (donc après une compaction aussi).

## Permissions

Les deux outils exposent des actions de permission `todowrite` et `todoread`.
Pour les désactiver ou les restreindre, ajouter des règles dans `permissions` :

```jsonc
{
  "permissions": [
    { "action": "todowrite", "resource": "*", "effect": "deny" }
  ]
}
```

Par défaut, ils sont disponibles sans demande de permission.

## Structure

```
index.js       # le plugin (ESM sans dépendance, entrypoint du répertoire)
package.json   # métadonnées du paquet
```

Le fichier `index.js` n'importe rien volontairement : OpenCode le charge tel quel,
sans build ni résolution de dépendances.
