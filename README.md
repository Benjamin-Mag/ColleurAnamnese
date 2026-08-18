# ColleurAnamnese — extension Chrome/Edge

Remplit automatiquement les champs de l'onglet "Anamnèse" sur une fiche Lead Salesforce, à partir de choix cliqués dans un panneau flottant plutôt que de cliquer champ par champ dans Salesforce.

## Utilisation

Sur une fiche Lead Salesforce (onglet Anamnèse), cliquer l'icône de l'extension → panneau flottant "🩺 Rapid Anamnèse". Cliquer le bandeau ouvre/ferme la liste complète des champs ; chaque champ s'affiche avec ses valeurs possibles en puces cliquables. Le bouton **"✅ Appliquer les choix"** en bas envoie tout d'un coup sur la vraie page Salesforce.

Situations 1/2 permettent en plus d'enregistrer des micro-modèles de phrases personnels (propres à cette installation), et ont un compteur COSI (−/+).

## Fichiers

- `popup.js` — toute la logique
- `popup.html` — popup fallback
- `manifest.json` — MV3, permissions `activeTab`, `scripting`, `storage`

## Installation / mise à jour

`chrome://extensions` → mode développeur → "Charger l'extension décompressée" → pointer sur ce dossier. Les nouvelles permissions (ex: `storage`) demandent parfois plus qu'un simple ↺ : supprimer puis recharger si un changement ne prend pas effet. Un panneau déjà ouvert garde l'ancien code tant qu'il n'est pas fermé et réinjecté.

## Champ non automatisable

"Traitement médical" (liste double Disponible/Sélectionné) : le clic sur la flèche de déplacement ne fonctionne jamais en script (Salesforce filtre sur `event.isTrusted`) — reste manuel, retiré du panneau.

## Projet frère

**MV Non Joignable** (`..\Extension Message Vocal\`) — même approche (traversée du shadow DOM Lightning, setter natif + `dispatchEvent`), pour une séquence d'actions fixe plutôt qu'un formulaire.
