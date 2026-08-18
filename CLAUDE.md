# Extension Chrome/Edge : ColleurAnamnese

## Dossier
`C:\Users\Benjamin.MAGNIER\Documents\Claude\Projects\Colleur Anamnese\` (déplacé depuis Desktop) — pas de repo git actuellement.
Zip de partage : `C:\Users\Benjamin.MAGNIER\Desktop\ColleurAnamnese.zip` (à régénérer après modif :
`Compress-Archive -Path "...\Colleur Anamnese\*" -DestinationPath "...\ColleurAnamnese.zip" -Force`)

## Ce que fait l'extension
Panneau flottant injecté sur une fiche Lead Salesforce (onglet "Anamnèse"). Un seul bouton visible
dans la barre du navigateur ("🩺 Rapid Anamnèse") :
- **Clic** sur le bandeau du panneau → ouvre/ferme la liste complète des champs de l'anamnèse
- **Glisser** le bandeau → déplace le panneau (seuil `DRAG_THRESHOLD` pour distinguer clic/glisser)
- Chaque champ s'affiche avec ses valeurs possibles en puces cliquables ; un bouton
  **"✅ Appliquer les choix"** en bas envoie tout d'un coup sur la vraie page Salesforce

## Fichiers clés
- `popup.js` — toute la logique (voir détail architecture ci-dessous)
- `popup.html` — fallback minimal si le popup s'ouvre hors page Salesforce
- `manifest.json` — MV3, permissions `activeTab`, `scripting`, `storage`

## Architecture popup.js (dans l'ordre du fichier)
1. **Helpers shadow DOM** : `getSR`/`dqAll` — percent les shadow roots Lightning (`.shadowRoot` en
   priorité, `chrome.dom.openOrClosedShadowRoot` en repli — l'ordre inverse a déjà causé un bug,
   voir commentaire dans le code)
2. **`isRendered`/`visibleEl`** — Salesforce Console garde plusieurs fiches montées en même temps
   dans le DOM ; `visibleEl` ignore les candidats à taille nulle (fiche en arrière-plan) et renvoie
   `null` s'il n'y a aucun candidat visible (ne JAMAIS retourner un candidat invisible par défaut —
   ça a fait remonter les champs de la mauvaise fiche par le passé)
3. **`selectPicklist(label, valeur)`** — remplit une liste déroulante simple
   (`lightning-base-combobox`) en cherchant le `<label>` par texte exact, puis son bouton via
   l'attribut `for`
4. **`fillTextInput(label, valeur)`** — remplit un champ texte simple (ex: commentaires, COSI)
5. **`FIELDS_CATALOG`** — liste figée en dur de tous les champs + leurs options (le formulaire est
   identique pour toutes les fiches, donc pas besoin de rescanner à chaque ouverture). Groupée par
   `section` (nom exact de la rubrique Salesforce) pour l'affichage.
6. **`CONDITIONAL_FIELDS`** — "Détails par rapport à l'appareillage" affiche des champs différents
   selon que "Type d'appareillage" = Premier appareillage ou Renouvellement — ces deux jeux sont
   affichés dynamiquement sous ce champ selon le choix cliqué
7. **`SITUATION_COMMENT_FIELD` / `SITUATION_COSI_FIELD`** — Situation 1/2 ont chacune un champ
   commentaire texte et un champ COSI numérique associés, gérés spécialement dans `renderFields`
8. **Micro-modèles de phrases** (`loadTemplates`/`saveTemplates`) — pour Situation 1/2, Benjamin
   peut créer ses propres phrases courtes (stockées dans `chrome.storage.local`, propres à cette
   installation) qui s'ajoutent au champ commentaire (jointes par " / "). Croix de suppression
   discrète au survol de chaque phrase (`.anm-phrase-del`, visible seulement au `:hover`).
9. **Compteur COSI** (`renderStepper`) — boutons −/+ compacts (bornés 1-5), placés à droite du
   titre "Situation 1/2" via le paramètre `titleExtra` de `renderFieldRow`
10. **`applySelections`** — au clic sur "Appliquer", parcourt `selections` (picklists),
    `commentSelections` (commentaires) et `numberSelections` (COSI) et remplit tout sur la vraie page

## Pièges déjà rencontrés (ne pas réintroduire)
- **Collision `<label>`** : les cases à cocher du panneau (`renderCheckboxRow`) utilisaient une
  vraie balise `<label>` contenant le même texte que le champ Salesforce visé — `selectPicklist`
  cherche `<label>` sur TOUT le document et retrouvait la case du panneau au lieu du vrai champ
  (→ "liste introuvable"). Utiliser `<div>` avec un `onclick` géré à la main à la place.
- **`document.getElementById` avant attachement au DOM** : appelé sur un élément pas encore
  attaché à `document.body` → renvoie `null` → crash silencieux du script, plus aucun écouteur posé
  (clic/glisser ne faisaient plus rien). Utiliser `parent.querySelector(...)` sur l'élément parent
  tant que le panneau n'est pas encore dans le document.
- **Rafraîchir une liste sans effacer les sélections** : `renderPhraseList` (juste réafficher les
  puces après ajout/suppression d'un modèle) est séparée de `renderSituationSubchoices` (qui
  réinitialise les choix, appelée seulement quand la situation change) — sinon ajouter une phrase
  effaçait les phrases déjà cochées.
- **"Traitement médical" (liste double Disponible/Sélectionné) non automatisable** : le clic sur la
  flèche de déplacement n'a aucun effet même simulé avec la séquence souris/clavier complète, alors
  que tout le reste marche. Tout porte à croire que Salesforce filtre cette action sur l'origine
  réelle de l'événement (`event.isTrusted`, jamais vrai pour un script) — même `.focus()`
  programmatique n'arrivait pas à déplacer le vrai focus vers ce bouton. Champ retiré du panneau,
  reste 100% manuel sur Salesforce.

## Installation / rechargement
Edge > Extensions > Mode développeur > Charger l'extension décompressée > pointer sur ce dossier.
**Les nouvelles permissions (ex: `storage`) demandent parfois plus qu'un simple ↻** : si un
changement ne prend pas effet, supprimer l'extension puis la recharger en mode non empaqueté.
Un panneau déjà ouvert sur une page garde l'ANCIEN code tant qu'il n'est pas fermé et réinjecté
(fermer via ×, puis recliquer l'icône de l'extension).
