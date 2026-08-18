// ============================================================
// PANNEAU SALESFORCE — Remplir l'anamnèse
// ============================================================
// Cliquer sur le bandeau "🩺 Rapid Anamnèse" ouvre/ferme le panneau (glisser
// le bandeau le déplace à la place, voir le seuil de distance DRAG_THRESHOLD
// plus bas). Le panneau liste tous les champs à choix de la page (liste figée
// en dur, voir FIELDS_CATALOG — le formulaire est identique pour toutes les
// fiches), affiche leurs options sous forme de puces cliquables, et un
// bouton "Appliquer" en bas envoie tous les choix faits d'un coup.
//
// Note : le champ "Traitement médical" (liste double Disponible/Sélectionné)
// n'a pas pu être automatisé pour le déplacement — le clic sur la flèche n'a
// aucun effet même simulé avec la séquence souris/clavier complète, alors que
// tout le reste (sélection d'options, listes déroulantes) fonctionne. Tout
// porte à croire que Salesforce filtre cette action sur l'origine réelle de
// l'événement (survient uniquement pour un vrai clic matériel), un signal
// qu'un script ne peut jamais reproduire. Ce champ reste donc à finaliser
// manuellement (sélectionner une valeur puis cliquer la flèche).
async function injecterPanelAnamnese(tab) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: function() {
      var existingPanel = document.getElementById('anamnese-fill-panel');
      if (existingPanel) { existingPanel.remove(); return 'removed'; }

      var PANEL_W = 300;
      var STORAGE_KEY = 'anamnesePanelState_v1';

      // Certains composants Lightning exposent un shadow root "open" (accessible
      // directement via .shadowRoot) ; d'autres non. chrome.dom.openOrClosedShadowRoot
      // couvre les deux cas MAIS peut renvoyer undefined sans lever d'exception
      // pour un élément qu'il ne reconnaît pas — il faut donc essayer .shadowRoot
      // en premier et ne se rabattre sur l'API chrome que s'il est absent.
      function getSR(el) {
        if (el.shadowRoot) return el.shadowRoot;
        try { return chrome.dom.openOrClosedShadowRoot(el); } catch (e) { return null; }
      }
      function dqAll(sel, root) {
        root = root || document;
        var res = Array.from(root.querySelectorAll(sel));
        root.querySelectorAll('*').forEach(function (e) { var sr = getSR(e); if (sr) res = res.concat(dqAll(sel, sr)); });
        return res;
      }
      function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

      // Salesforce Console garde parfois plusieurs fiches montées en même
      // temps dans le DOM (onglets internes) ; une fiche inactive est
      // masquée en CSS (taille nulle). On ne doit PAS exiger que l'élément
      // soit dans la zone actuellement scrollée à l'écran : un champ plus
      // bas dans une page scrollable a une taille réelle même hors du
      // viewport visible pour l'instant.
      function isRendered(el) {
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }
      // Ne jamais retourner un candidat invisible en dernier recours (voir
      // ColleurDoctolib) : une fiche ouverte en arrière-plan dans un autre
      // onglet Salesforce Console garde ses champs montés dans le DOM à
      // taille 0 — les renvoyer par défaut ferait remonter les champs de la
      // MAUVAISE fiche.
      function visibleEl(candidates) {
        for (var i = candidates.length - 1; i >= 0; i--) {
          if (isRendered(candidates[i])) return candidates[i];
        }
        return null;
      }

      // ---- Picklist simple (lightning-base-combobox : bouton role=combobox
      // + options role=option, id préfixé par l'id du bouton) ----
      async function selectPicklist(labelText, valueText) {
        var labels = dqAll('label').filter(function (l) { return (l.innerText || '').trim() === labelText; });
        var lbl = visibleEl(labels);
        if (!lbl) return { ok: false, msg: 'champ introuvable : ' + labelText };
        var forId = lbl.getAttribute('for');
        var btn = forId ? dqAll('#' + CSS.escape(forId))[0] : null;
        if (!btn) return { ok: false, msg: 'liste introuvable : ' + labelText };
        if (btn.getAttribute('data-value') === valueText) return { ok: true, msg: labelText + ' déjà à ' + valueText };
        btn.click();
        await sleep(250);
        for (var i = 0; i < 15; i++) {
          var opts = dqAll('[id^="' + forId + '-"]').filter(function (o) { return o.getAttribute('role') === 'option'; });
          var target = opts.find(function (o) { return (o.innerText || o.textContent || '').trim() === valueText; });
          if (target) { target.click(); await sleep(150); return { ok: true, msg: labelText + ' → ' + valueText }; }
          await sleep(100);
        }
        return { ok: false, msg: 'option "' + valueText + '" introuvable pour ' + labelText };
      }

      // ---- Champ texte simple (ex: "Situation 1 - commentaires") ----
      // Le label peut pointer directement sur l'input/textarea, ou sur un
      // composant Lightning qui l'enveloppe (comme pour les picklists) — on
      // gère les deux cas.
      async function fillTextInput(labelText, value) {
        var labels = dqAll('label').filter(function (l) { return (l.innerText || '').trim() === labelText; });
        var lbl = visibleEl(labels);
        if (!lbl) return { ok: false, msg: 'champ introuvable : ' + labelText };
        var forId = lbl.getAttribute('for');
        var el = forId ? dqAll('#' + CSS.escape(forId))[0] : null;
        if (!el) return { ok: false, msg: 'champ texte introuvable : ' + labelText };
        var input = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? el : dqAll('input, textarea', el)[0];
        if (!input) return { ok: false, msg: 'zone de saisie introuvable : ' + labelText };
        var proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, msg: labelText + ' → texte rempli' };
      }

      var selections = {}; // forId -> { label, value }
      var commentSelections = {}; // label du champ commentaire -> [phrase, ...]
      var numberSelections = {}; // label du champ COSI -> valeur (string), seulement si touché

      // ---- Sous-choix personnalisés ("micro-modèles") pour les champs
      // Situation 1/2 — stockés dans chrome.storage.local : propre à cette
      // installation de l'extension (chaque collègue construit les siens),
      // persiste tant que l'extension n'est pas désinstallée.
      var TEMPLATES_KEY = 'anamneseSituationTemplates_v1';
      var SITUATION_COMMENT_FIELD = {
        'Situation très importante 1': 'Situation 1 - commentaires',
        'Situation très importante 2': 'Situation 2 - commentaires'
      };
      // Le champ COSI n'est pas lié à la valeur de la situation choisie
      // (juste une intensité 0-10) : il ne se réinitialise donc pas quand on
      // change de situation, contrairement aux phrases-modèles.
      var SITUATION_COSI_FIELD = {
        'Situation très importante 1': "COSI 1 - évaluation: l'intensité!",
        'Situation très importante 2': "COSI 2 - évaluation: l'intensité!"
      };
      var templatesCache = null;
      // Si l'extension n'a pas encore été rechargée après l'ajout de la
      // permission "storage" (ou si elle échoue pour toute autre raison),
      // chrome.storage.local peut être indisponible — on se rabat alors sur
      // un simple objet en mémoire (fonctionne pour la session en cours,
      // mais rien n'est gardé après fermeture du panneau) plutôt que de
      // planter silencieusement et n'afficher aucune zone d'ajout.
      function loadTemplates() {
        return new Promise(function (resolve) {
          if (templatesCache) { resolve(templatesCache); return; }
          try {
            chrome.storage.local.get([TEMPLATES_KEY], function (res) {
              templatesCache = (res && res[TEMPLATES_KEY]) || {};
              resolve(templatesCache);
            });
          } catch (e) {
            templatesCache = {};
            resolve(templatesCache);
          }
        });
      }
      function saveTemplates() {
        try {
          var obj = {}; obj[TEMPLATES_KEY] = templatesCache || {};
          chrome.storage.local.set(obj);
        } catch (e) {}
      }

      function showStatus(msg, ok) {
        var st = document.getElementById('anm-panel-status');
        if (st) { st.textContent = msg; st.style.color = ok ? '#4c1d95' : '#c0392b'; st.style.display = msg ? 'block' : 'none'; }
      }

      function makeChip(fieldData, opt, chipsWrap, onSelect) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.textContent = opt;
        chip.style.cssText = 'padding:4px 9px;border-radius:12px;border:1px solid #d8d0ea;background:#f7f5fb;color:#333;font-size:11px;cursor:pointer;';
        chip.addEventListener('click', function () {
          // Clé = label, pas forId : forId change à chaque chargement de
          // page et est absent des champs restitués depuis le cache — le
          // garder comme clé ferait collisionner tous les champs entre eux.
          var current = selections[fieldData.label];
          Array.from(chipsWrap.children).forEach(function (c) {
            c.style.background = '#f7f5fb'; c.style.color = '#333'; c.style.borderColor = '#d8d0ea';
          });
          if (current && current.value === opt) {
            delete selections[fieldData.label];
            if (onSelect) onSelect(null);
          } else {
            selections[fieldData.label] = { label: fieldData.label, value: opt };
            chip.style.background = '#4c1d95'; chip.style.color = '#fff'; chip.style.borderColor = '#4c1d95';
            if (onSelect) onSelect(opt);
          }
        });
        return chip;
      }

      function renderFieldRow(fieldData, onSelect, titleExtra) {
        var row = document.createElement('div');
        row.style.cssText = 'margin-bottom:10px;';
        var titleRow = document.createElement('div');
        titleRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;';
        var lbl = document.createElement('span');
        lbl.textContent = fieldData.displayLabel || fieldData.label;
        lbl.style.cssText = 'font-size:11px;font-weight:600;color:#333;';
        titleRow.appendChild(lbl);
        if (titleExtra) titleRow.appendChild(titleExtra);
        row.appendChild(titleRow);
        var chipsWrap = document.createElement('div');
        chipsWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;';
        fieldData.options.forEach(function (opt) { chipsWrap.appendChild(makeChip(fieldData, opt, chipsWrap, onSelect)); });
        row.appendChild(chipsWrap);
        return row;
      }

      // Champs Oui/Non uniquement (ex: Perte auditive fluctuante) : une case
      // à cocher sur la ligne du titre est plus rapide qu'une puce à choisir.
      // Décochée = Non par défaut — la case est TOUJOURS incluse dans les
      // choix à appliquer (contrairement aux puces, qui restent "non
      // touchées" tant qu'on ne clique pas dessus).
      function isBinaryOuiNon(opts) {
        return opts.length === 2 && opts.indexOf('Oui') !== -1 && opts.indexOf('Non') !== -1;
      }
      // Une vraie balise <label> ici entrerait en collision avec la
      // recherche de champs sur la page Salesforce (selectPicklist cherche
      // <label> sur TOUT le document) : notre propre case, ajoutée après
      // coup à document.body, se ferait alors retrouver À LA PLACE du champ
      // réel — et comme elle n'a pas d'attribut "for", ça donnait
      // "liste introuvable" pour tous les champs concernés. On utilise donc
      // un <div> avec un clic géré à la main pour garder le même confort
      // (cliquer n'importe où sur la ligne coche/décoche).
      function renderCheckboxRow(fieldData) {
        var row = document.createElement('div');
        row.style.cssText =
          'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;' +
          'font-size:11px;font-weight:600;color:#333;cursor:pointer;user-select:none;';
        var span = document.createElement('span');
        span.textContent = fieldData.displayLabel || fieldData.label;
        row.appendChild(span);
        var checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.style.cssText = 'width:16px;height:16px;accent-color:#4c1d95;cursor:pointer;flex-shrink:0;';
        checkbox.addEventListener('change', function () {
          selections[fieldData.label] = { label: fieldData.label, value: checkbox.checked ? 'Oui' : 'Non' };
        });
        row.appendChild(checkbox);
        row.addEventListener('click', function (e) {
          if (e.target === checkbox) return;
          checkbox.checked = !checkbox.checked;
          checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        });
        selections[fieldData.label] = { label: fieldData.label, value: 'Non' };
        return row;
      }

      // Compteur +/- compact (juste les boutons, pas de texte) pour un champ
      // numérique simple (ex: "COSI 1 - évaluation: l'intensité!"), pensé
      // pour être placé à côté d'un titre (voir renderFieldRow/titleExtra).
      // Non touché = non appliqué au clic sur "Appliquer" (comme les puces),
      // pour ne pas écraser une valeur déjà saisie sur Salesforce.
      function renderStepper(cosiLabel) {
        var controls = document.createElement('div');
        controls.style.cssText = 'display:flex;align-items:center;gap:6px;flex-shrink:0;';
        var btnStyle = 'width:20px;height:20px;border:none;border-radius:50%;background:#4c1d95;color:#fff;font-size:13px;cursor:pointer;line-height:1;flex-shrink:0;';

        var minusBtn = document.createElement('button');
        minusBtn.type = 'button';
        minusBtn.textContent = '−';
        minusBtn.style.cssText = btnStyle;

        var valueSpan = document.createElement('span');
        valueSpan.style.cssText = 'min-width:14px;text-align:center;font-size:11px;font-weight:600;color:#333;';
        var value = 1;
        valueSpan.textContent = value;

        var plusBtn = document.createElement('button');
        plusBtn.type = 'button';
        plusBtn.textContent = '+';
        plusBtn.style.cssText = btnStyle;

        function update(delta) {
          value = Math.max(1, Math.min(5, value + delta));
          valueSpan.textContent = value;
          numberSelections[cosiLabel] = String(value);
        }
        minusBtn.addEventListener('click', function () { update(-1); });
        plusBtn.addEventListener('click', function () { update(1); });

        controls.appendChild(minusBtn); controls.appendChild(valueSpan); controls.appendChild(plusBtn);
        return controls;
      }

      // Le formulaire d'anamnèse est identique pour toutes les fiches — plutôt
      // que de re-scanner la page à chaque ouverture, la liste des champs et
      // de leurs options est figée en dur ici.
      // "section" = intitulé exact de la rubrique repliable sur la page
      // Salesforce — sert à regrouper visuellement les champs (voir
      // renderFields / renderSectionHeader).
      var FIELDS_CATALOG = [
        { label: "Civilité", section: "Informations client", options: ["- Aucun -", "M.", "Mme"] },
        { label: "Type d'appareillage", section: "Détails par rapport à l'appareillage", options: ["- Aucun -", "Premier appareillage", "Renouvellement d'appareillage"] },
        { label: "Situation très importante 1", displayLabel: "Situation 1", section: "Analyse des besoins auditifs", options: ["- Aucun -", "Musique", "Conversations de groupe", "Loisirs", "Télévision", "Travail", "Restaurant", "Téléphone"] },
        { label: "Situation très importante 2", displayLabel: "Situation 2", section: "Analyse des besoins auditifs", options: ["- Aucun -", "Musique", "Conversations de groupe", "Loisirs", "Télévision", "Travail", "Restaurant", "Téléphone"] },
        { label: "Statut professionnel", section: "Analyse des besoins auditifs", options: ["- Aucun -", "Actif/ active", "Retraité/e", "Inconnu"] },
        { label: "Exposition aux nuisances sonores", section: "Analyse des besoins auditifs", options: ["- Aucun -", "Oui", "Non"] },
        { label: "Type d'appareil préféré", section: "Attentes du client", options: ["- Aucun -", "BTE", "Intra-auriculaire", "RIC"] },
        { label: "Design discret", section: "Attentes du client", options: ["- Aucun -", "Moins important", "Important", "Très important"] },
        { label: "Smartphone", section: "Attentes du client", options: ["- Aucun -", "Android", "IOS", "Windows", "Autre marque", "pas de Smartphone"] },
        { label: "Perte auditive fluctuante", section: "Antécédents médicaux", options: ["- Aucun -", "Oui", "Non"] },
        { label: "Opération à l'oreille", section: "Antécédents médicaux", options: ["- Aucun -", "Oui", "Non"] },
        { label: "Otite", section: "Antécédents médicaux", options: ["- Aucun -", "Oui", "Non"] },
        { label: "Surdité brusque", section: "Antécédents médicaux", options: ["- Aucun -", "Oui", "Non"] },
        { label: "Acouphènes", section: "Antécédents médicaux", options: ["- Aucun -", "Non", "Les deux oreilles", "Oreille gauche", "Oreille droite"] },
        { label: "Mutuelle", section: "Coordonnées client", options: ["- Aucun -", "Yes", "No"] }
      ];

      // "Détails par rapport à l'appareillage" affiche des champs différents
      // selon la réponse à "Type d'appareillage" — ces deux jeux ne sont donc
      // PAS dans FIELDS_CATALOG mais affichés dynamiquement juste en dessous
      // de ce champ, en fonction du choix cliqué (voir renderFields). Même
      // section que "Type d'appareillage" puisqu'ils en font partie sur la page.
      var CONDITIONAL_FIELDS = {
        "Premier appareillage": [
          { label: "Perte auditive", options: ["- Aucun -", "Binaurale", "Monaurale gauche", "Monaurale droite"] },
          { label: "Problèmes d'audition depuis quand?", options: ["- Aucun -", "Plus de 5 ans", "Moins de 6 mois", "Plus de 6 mois"] },
          { label: "Test auditif récent?", options: ["- Aucun -", "Oui", "Non"] },
          { label: "Test auditif récent - où ?", options: ["- Aucun -", "ORL", "Audioprothésiste", "Non renseigné", "Généraliste", "Médecine de travail"] },
          { label: "Ordonnance", options: ["- Aucun -", "Oui", "Non", "Oui, mais elle a plus d'un an"] }
        ],
        "Renouvellement d'appareillage": [
          { label: "Age de l'aide auditive actuelle", options: ["- Aucun -", "1", "2", "3", "4+"] },
          { label: "Type d'aide auditive actuelle", options: ["- Aucun -", "Intra-auriculaire", "Contour (BTE)", "RIC"] },
          { label: "Fabricant de l'aide auditive actuelle", options: ["- Aucun -", "AudioService", "Beltone", "Bernafon", "Cortitone", "Hansaton", "Interton", "Autre", "Oticon", "Panasonic", "Phonak", "Private label", "Resound", "Rexton", "Rionet", "Siemens", "Sonic Innovations", "Starkey", "Unitron", "Widex", "Signia"] },
          { label: "Satisfaction à l'égard des AA actuelles", options: ["- Aucun -", "Pas satisfait", "Satisfait", "Très satisfait"] }
        ]
      };

      // Champs à ne pas proposer du tout (bruit inutile pour Benjamin).
      var EXCLUDED_LABEL_KEYWORDS = ['fabricant', 'smartphone'];
      function isExcludedLabel(label) {
        var l = label.toLowerCase();
        return EXCLUDED_LABEL_KEYWORDS.some(function (kw) { return l.indexOf(kw) !== -1; });
      }
      // "- Aucun -" est la valeur par défaut/non-réponse : jamais utile comme
      // choix à cliquer, on la retire de toutes les puces.
      function isAucunOption(opt) {
        return opt.replace(/^[-\s]+|[-\s]+$/g, '').toLowerCase() === 'aucun';
      }
      // Filtrage appliqué à l'affichage (pas à la découverte/au cache) pour
      // que ces règles s'appliquent même à des données déjà en cache sans
      // avoir besoin de forcer un rafraîchissement.
      function processFields(rawFields) {
        var seenLabels = {};
        var out = [];
        rawFields.forEach(function (f) {
          if (isExcludedLabel(f.label)) return;
          if (seenLabels[f.label]) return; // ne garde que la 1re occurrence (ex: Civilité du haut)
          seenLabels[f.label] = true;
          var opts = (f.options || []).filter(function (o) { return !isAucunOption(o); });
          if (!opts.length) return;
          out.push({ label: f.label, displayLabel: f.displayLabel, section: f.section, options: opts });
        });
        return out;
      }

      function renderSectionHeader(text) {
        var h = document.createElement('div');
        h.textContent = text;
        h.style.cssText =
          'font-size:10px;font-weight:700;color:#4c1d95;text-transform:uppercase;letter-spacing:.04em;' +
          'margin:14px 0 6px;padding-bottom:3px;border-bottom:1px solid #e2dbf3;';
        return h;
      }

      // Efface les choix faits dans l'UN OU L'AUTRE jeu de champs
      // conditionnels — évite qu'un choix fait pour "Renouvellement" reste
      // en mémoire (et soit appliqué) après être repassé sur "Premier".
      function clearConditionalSelections() {
        Object.keys(CONDITIONAL_FIELDS).forEach(function (key) {
          CONDITIONAL_FIELDS[key].forEach(function (f) { delete selections[f.label]; });
        });
      }

      function renderConditionalSection(container, typeValue) {
        clearConditionalSelections();
        container.innerHTML = '';
        var raw = CONDITIONAL_FIELDS[typeValue];
        if (!raw) return;
        processFields(raw).forEach(function (f) { container.appendChild(renderFieldRow(f)); });
      }

      // Sous-choix ("micro-modèles") propres à la situation choisie pour
      // Situation 1/2 : des phrases courtes qu'on peut cumuler (clic pour
      // ajouter/retirer), plus un mini-formulaire pour en créer de
      // nouvelles — elles sont ensuite jointes par " / " et envoyées dans
      // le champ "Situation X - commentaires" au moment d'Appliquer.
      // Appelée quand la situation choisie CHANGE (ou est désélectionnée) —
      // remet les phrases cochées à zéro, puisqu'elles ne concernent plus la
      // même situation, puis délègue l'affichage à renderPhraseList.
      function renderSituationSubchoices(container, situationValue, commentFieldLabel) {
        container.innerHTML = '';
        if (!situationValue) { delete commentSelections[commentFieldLabel]; return; }
        commentSelections[commentFieldLabel] = [];
        renderPhraseList(container, situationValue, commentFieldLabel);
      }

      // Rafraîchit juste la liste de puces + le mini-formulaire d'ajout,
      // SANS toucher commentSelections — appelée après ajout/suppression
      // d'un modèle pour ne pas effacer les phrases déjà cochées par
      // Benjamin (bug initial : ajouter/supprimer une phrase désélectionnait
      // tout ce qu'il avait déjà coché pour cette situation).
      function renderPhraseList(container, situationValue, commentFieldLabel) {
        loadTemplates().then(function (templates) {
          container.innerHTML = '';
          var phrases = templates[situationValue] || [];
          var selectedArr = commentSelections[commentFieldLabel] || [];

          var wrap = document.createElement('div');
          wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin:2px 0 4px 10px;';
          phrases.forEach(function (phrase) {
            var isSelected = selectedArr.indexOf(phrase) !== -1;
            var chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'anm-phrase-chip';
            chip.style.cssText = 'padding:3px 8px;border-radius:10px;border:1px solid #cfe0d8;font-size:10px;cursor:pointer;' +
              (isSelected ? 'background:#1f6e46;color:#fff;' : 'background:#eef7f1;color:#1f6e46;');
            var chipLabel = document.createElement('span');
            chipLabel.textContent = phrase;
            chip.appendChild(chipLabel);
            // Croix visible seulement au survol (voir règle .anm-phrase-chip:hover
            // .anm-phrase-del) : moyen discret de supprimer un modèle enregistré
            // sans encombrer l'affichage ni risquer un clic accidentel.
            var delBtn = document.createElement('span');
            delBtn.className = 'anm-phrase-del';
            delBtn.textContent = '×';
            delBtn.title = 'Supprimer ce modèle';
            delBtn.addEventListener('click', function (e) {
              e.stopPropagation();
              var idx = (templatesCache[situationValue] || []).indexOf(phrase);
              if (idx !== -1) templatesCache[situationValue].splice(idx, 1);
              saveTemplates();
              var arr = commentSelections[commentFieldLabel];
              if (arr) { var si = arr.indexOf(phrase); if (si !== -1) arr.splice(si, 1); }
              renderPhraseList(container, situationValue, commentFieldLabel);
            });
            chip.appendChild(delBtn);
            chip.addEventListener('click', function () {
              var arr = commentSelections[commentFieldLabel] || (commentSelections[commentFieldLabel] = []);
              var idx = arr.indexOf(phrase);
              if (idx !== -1) { arr.splice(idx, 1); chip.style.background = '#eef7f1'; chip.style.color = '#1f6e46'; }
              else { arr.push(phrase); chip.style.background = '#1f6e46'; chip.style.color = '#fff'; }
            });
            wrap.appendChild(chip);
          });
          container.appendChild(wrap);

          var addRow = document.createElement('div');
          addRow.style.cssText = 'display:flex;gap:4px;margin:0 0 8px 10px;';
          var input = document.createElement('input');
          input.type = 'text';
          input.placeholder = 'Nouvelle phrase…';
          input.style.cssText = 'flex:1;min-width:0;font-size:10px;padding:3px 6px;border:1px solid #d8d0ea;border-radius:6px;';
          var addBtn = document.createElement('button');
          addBtn.type = 'button';
          addBtn.textContent = '+';
          addBtn.title = 'Ajouter cette phrase comme modèle pour "' + situationValue + '"';
          addBtn.style.cssText = 'padding:3px 10px;border:none;border-radius:6px;background:#4c1d95;color:#fff;font-size:11px;cursor:pointer;flex-shrink:0;';
          function addPhrase() {
            var text = input.value.trim();
            if (!text) return;
            templatesCache[situationValue] = templatesCache[situationValue] || [];
            if (templatesCache[situationValue].indexOf(text) === -1) templatesCache[situationValue].push(text);
            saveTemplates();
            input.value = '';
            renderPhraseList(container, situationValue, commentFieldLabel);
          }
          addBtn.addEventListener('click', addPhrase);
          input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addPhrase(); } });
          addRow.appendChild(input); addRow.appendChild(addBtn);
          container.appendChild(addRow);
        });
      }

      function renderFields(rawFields) {
        var body = document.getElementById('anm-explorer-body');
        var applyBtn = document.getElementById('anm-apply-btn');
        body.innerHTML = '';
        var fieldsWithOptions = processFields(rawFields);
        if (!fieldsWithOptions.length) {
          body.innerHTML = '<p style="font-size:11px;color:#777;text-align:center;margin:8px 0;">Aucun champ trouvé.</p>';
          return;
        }
        var lastSection = null;
        fieldsWithOptions.forEach(function (f) {
          if (f.section && f.section !== lastSection) {
            lastSection = f.section;
            body.appendChild(renderSectionHeader(f.section));
          }
          if (f.label === "Type d'appareillage") {
            var conditionalContainer = document.createElement('div');
            body.appendChild(renderFieldRow(f, function (chosenValue) {
              renderConditionalSection(conditionalContainer, chosenValue);
            }));
            body.appendChild(conditionalContainer);
            var existing = selections["Type d'appareillage"];
            if (existing) renderConditionalSection(conditionalContainer, existing.value);
          } else if (SITUATION_COMMENT_FIELD[f.label]) {
            var commentLabel = SITUATION_COMMENT_FIELD[f.label];
            var subContainer = document.createElement('div');
            var stepper = SITUATION_COSI_FIELD[f.label] ? renderStepper(SITUATION_COSI_FIELD[f.label]) : null;
            body.appendChild(renderFieldRow(f, function (chosenValue) {
              renderSituationSubchoices(subContainer, chosenValue, commentLabel);
            }, stepper));
            body.appendChild(subContainer);
            var existingSituation = selections[f.label];
            if (existingSituation) renderSituationSubchoices(subContainer, existingSituation.value, commentLabel);
          } else if (f.section === 'Antécédents médicaux' && isBinaryOuiNon(f.options)) {
            body.appendChild(renderCheckboxRow(f));
          } else {
            body.appendChild(renderFieldRow(f));
          }
        });
        applyBtn.style.display = 'block';
      }

      async function applySelections() {
        var entries = Object.keys(selections).map(function (k) { return selections[k]; });
        var commentEntries = Object.keys(commentSelections).filter(function (k) { return commentSelections[k].length > 0; });
        var numberEntries = Object.keys(numberSelections);
        if (!entries.length && !commentEntries.length && !numberEntries.length) { showStatus('Aucune valeur choisie', false); return; }
        var applyBtn = document.getElementById('anm-apply-btn');
        var originalText = applyBtn.textContent;
        applyBtn.textContent = '⏳ Application…';
        applyBtn.disabled = true;
        try {
          var results = [];
          for (var i = 0; i < entries.length; i++) { results.push(await selectPicklist(entries[i].label, entries[i].value)); }
          for (var j = 0; j < commentEntries.length; j++) {
            var commentLabel = commentEntries[j];
            var text = commentSelections[commentLabel].join(' / ');
            results.push(await fillTextInput(commentLabel, text));
          }
          for (var n = 0; n < numberEntries.length; n++) {
            var cosiLabel = numberEntries[n];
            results.push(await fillTextInput(cosiLabel, numberSelections[cosiLabel]));
          }
          var failed = results.filter(function (r) { return !r.ok; });
          if (failed.length) {
            showStatus('Incomplet : ' + failed.map(function (r) { return r.msg; }).join(' / '), false);
          } else {
            showStatus(results.length + ' champ(s) rempli(s)', true);
          }
        } catch (e) {
          showStatus('Erreur : ' + e.message, false);
        } finally {
          applyBtn.textContent = originalText;
          applyBtn.disabled = false;
        }
      }

      function loadState() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch (e) { return {}; } }
      function saveState(state) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {} }
      function clamp(top, left) {
        var maxLeft = Math.max(0, window.innerWidth - PANEL_W);
        var maxTop = Math.max(0, window.innerHeight - 40);
        return { top: Math.min(Math.max(top, 0), maxTop), left: Math.min(Math.max(left, 0), maxLeft) };
      }

      var saved = loadState();
      var pos = clamp(
        typeof saved.top === 'number' ? saved.top : 80,
        typeof saved.left === 'number' ? saved.left : (window.innerWidth - PANEL_W - 20)
      );

      var panel = document.createElement('div');
      panel.id = 'anamnese-fill-panel';
      panel.style.cssText =
        'position:fixed;top:' + pos.top + 'px;left:' + pos.left + 'px;width:' + PANEL_W + 'px;' +
        'max-height:80vh;display:flex;flex-direction:column;' +
        'z-index:2147483647;background:#fff;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.25);' +
        'font-family:Arial,Helvetica,sans-serif;overflow:hidden;user-select:none;';

      if (!document.getElementById('anm-bar-btn-style')) {
        var barStyle = document.createElement('style');
        barStyle.id = 'anm-bar-btn-style';
        barStyle.textContent =
          '.anm-bar-btn{transition:filter .1s ease;} .anm-bar-btn:hover{filter:brightness(1.1);} .anm-bar-btn:active{filter:brightness(.88);}' +
          '.anm-phrase-del{display:none;margin-left:5px;opacity:.6;font-weight:700;} .anm-phrase-chip:hover .anm-phrase-del{display:inline;} .anm-phrase-del:hover{opacity:1;}';
        document.head.appendChild(barStyle);
      }

      var bar = document.createElement('div');
      bar.id = 'anm-block-btn';
      bar.className = 'anm-bar-btn';
      bar.style.cssText =
        'display:flex;align-items:center;gap:6px;background:#4c1d95;color:#fff;padding:12px 10px;' +
        'cursor:pointer;font-size:13px;font-weight:600;box-shadow:inset 0 -2px 0 rgba(0,0,0,.12);flex-shrink:0;';
      bar.innerHTML =
        '<span id="anm-block-label" style="flex:1;text-align:center;">🩺 Rapid Anamnèse</span>' +
        '<button id="anm-panel-close" title="Fermer" style="width:20px;height:20px;border:none;border-radius:5px;background:rgba(255,255,255,.2);color:#fff;cursor:pointer;font-size:13px;line-height:1;flex-shrink:0;">×</button>';
      panel.appendChild(bar);

      var explorerWrap = document.createElement('div');
      explorerWrap.id = 'anm-explorer-wrap';
      explorerWrap.style.cssText = 'display:none;flex-direction:column;overflow:hidden;flex:1;min-height:0;';

      var explorerBody = document.createElement('div');
      explorerBody.id = 'anm-explorer-body';
      explorerBody.style.cssText = 'padding:10px;overflow-y:auto;flex:1;min-height:0;';
      explorerWrap.appendChild(explorerBody);

      var applyBtn = document.createElement('button');
      applyBtn.id = 'anm-apply-btn';
      applyBtn.type = 'button';
      applyBtn.textContent = '✅ Appliquer les choix';
      applyBtn.style.cssText =
        'display:none;width:calc(100% - 20px);margin:0 10px 10px;padding:9px;background:#4c1d95;color:#fff;' +
        'border:none;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;flex-shrink:0;';
      explorerWrap.appendChild(applyBtn);
      panel.appendChild(explorerWrap);

      var status = document.createElement('p');
      status.id = 'anm-panel-status';
      status.style.cssText = 'display:none;margin:0;padding:6px 10px 8px;font-size:11px;color:#555;text-align:center;word-break:break-word;flex-shrink:0;';
      panel.appendChild(status);

      document.body.appendChild(panel);

      var explorerLoaded = false;
      function toggleExplorer() {
        var isOpen = explorerWrap.style.display !== 'none';
        explorerWrap.style.display = isOpen ? 'none' : 'flex';
        if (!isOpen && !explorerLoaded) { explorerLoaded = true; renderFields(FIELDS_CATALOG); }
      }
      applyBtn.addEventListener('click', applySelections);

      var G = window.__anamnesePanelDrag || (window.__anamnesePanelDrag = {});
      G.panel = panel; G.clamp = clamp; G.onClick = toggleExplorer;

      bar.addEventListener('mousedown', function (e) {
        if (e.target.closest('button')) return;
        G.downX = e.clientX; G.downY = e.clientY;
        G.startLeft = panel.offsetLeft; G.startTop = panel.offsetTop;
        G.dragging = false;
        e.preventDefault();
      });

      var H = window.__anamnesePanelHandlers;
      if (H) {
        document.removeEventListener('mousemove', H.mousemove);
        document.removeEventListener('mouseup', H.mouseup);
        window.removeEventListener('resize', H.resize);
        document.removeEventListener('click', H.click);
      }
      H = window.__anamnesePanelHandlers = {};
      var DRAG_THRESHOLD = 4;
      H.mousemove = function (e) {
        if (!G.panel || !G.panel.isConnected || G.downX === undefined) return;
        var dx = e.clientX - G.downX, dy = e.clientY - G.downY;
        if (!G.dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        G.dragging = true;
        var next = G.clamp(G.startTop + dy, G.startLeft + dx);
        G.panel.style.top = next.top + 'px';
        G.panel.style.left = next.left + 'px';
      };
      H.mouseup = function () {
        if (!G.panel || G.downX === undefined) return;
        var wasDragging = G.dragging;
        if (wasDragging) {
          try {
            var s = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
            s.top = G.panel.offsetTop; s.left = G.panel.offsetLeft;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
          } catch (e) {}
        }
        G.downX = undefined; G.dragging = false;
        if (!wasDragging && G.onClick) G.onClick();
      };
      H.resize = function () {
        if (!G.panel || !G.panel.isConnected) return;
        var next = G.clamp(G.panel.offsetTop, G.panel.offsetLeft);
        G.panel.style.top = next.top + 'px';
        G.panel.style.left = next.left + 'px';
      };
      H.click = function (e) {
        if (!G.panel || !G.panel.isConnected || G.panel.contains(e.target)) return;
        var st = document.getElementById('anm-panel-status');
        if (st) { st.style.display = 'none'; st.textContent = ''; }
      };
      document.addEventListener('mousemove', H.mousemove);
      document.addEventListener('mouseup', H.mouseup);
      window.addEventListener('resize', H.resize);
      document.addEventListener('click', H.click);

      document.getElementById('anm-panel-close').addEventListener('click', function () { panel.remove(); });

      return 'injected';
    }
  });
}

// ============================================================
// DÉMARRAGE
// ============================================================
document.addEventListener('DOMContentLoaded', async function () {
  var status = document.getElementById('status');
  var [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;

  if (/force\.com|salesforce\.com/i.test(tab.url)) {
    await injecterPanelAnamnese(tab);
    window.close();
    return;
  }
  if (status) { status.textContent = 'Ouvre une fiche Salesforce (onglet Anamnèse).'; }
});
