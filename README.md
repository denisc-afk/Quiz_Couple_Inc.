# Indice Couple inc.

Diagnostic en ligne d'acquisition pour **Couple inc.**, un programme **Ax-One**.
Douze énoncés, deux lectures, un Indice — et l'écart entre les deux versions d'une même relation.

> ⚠️ **Dépôt privé.** Il contient l'algorithme, les douze énoncés, les contenus des cinq
> piliers et les vingt-sept courriels : c'est la totalité de la propriété intellectuelle
> du programme. Ne le rendez jamais public.

---

## Ce que c'est

Un **seul fichier** (`src/worker.js`, ~100 Ko) fait tout : il contient la page web, il calcule
les indices, il garde la lecture de la première personne pour la joindre à celle du partenaire,
et il crée le contact dans GoHighLevel déjà taggé et rempli.

```
coupleinc.ca  →  Worker Cloudflare
   /          sert la page (elle est embarquée dans le fichier)
   /api/…     calcul · stockage KV du lien partenaire · appels API GHL
                                    │
                                    ▼
                            GoHighLevel
                     contact + 19 champs + tags
                                    │
                                    ▼
                     workflows → 27 courriels
                     calendrier → Martine
```

**Pourquoi un fichier unique.** Séparer la page et l'API sur deux domaines imposait une
variable d'origine, exposait aux erreurs de type CORS et forçait à éditer un fichier HTML à
la main. Tout ça disparaît quand le Worker sert lui-même la page.

---

## Déployer

Aujourd'hui, le déploiement est manuel et c'est volontairement simple :

1. Ouvrir `src/worker.js`, tout copier
2. Cloudflare → **Workers & Pages** → Worker `indice-couple` → **Edit code**
3. Tout sélectionner, remplacer, **Deploy**

Rien à modifier dans le fichier. Toute la configuration vit dans les variables Cloudflare.

`wrangler.jsonc` est fourni pour le jour où quelqu'un branchera le déploiement automatique
depuis ce dépôt. **Ne le connectez pas sans votre intégrateur** : la configuration du fichier
remplacerait alors celle du tableau de bord.

---

## Configuration (dans Cloudflare, jamais dans le code)

| Variable | Type | Rôle |
|---|---|---|
| `GHL_TOKEN` | **Secret** | Jeton d'intégration privée GoHighLevel (contacts : lecture + écriture) |
| `GHL_LOCATION_ID` | Texte | Identifiant du sous-compte GHL |
| `CALENDRIER` | Texte | Lien du calendrier de Martine |
| `CONFIDENTIALITE` | Texte | Lien de la politique de confidentialité |
| `KV` | Binding KV | Namespace `INDICE_COUPLE` — le nom du binding doit être exactement `KV` |

Domaine : Worker → Settings → Domains & Routes → Add → Custom domain.

> **Le jeton ne doit jamais entrer dans ce dépôt.** Il n'est pas dans le code, il n'est pas
> dans `wrangler.jsonc`, et `.gitignore` bloque les fichiers d'environnement. Si un jeton est
> committé un jour, le retirer du fichier ne suffit pas : il faut le révoquer dans GHL et en
> générer un nouveau, parce qu'il reste dans l'historique Git.

---

## Routes

| Route | Usage |
|---|---|
| `GET /` | Sert la page |
| `POST /api/duo` | Parcours « ensemble » : les deux lectures d'un coup |
| `POST /api/solo` | Première lecture; renvoie le jeton du lien partenaire |
| `GET /api/lien?t=` | Le partenaire ouvre son lien (prénoms seulement) |
| `POST /api/join` | Le partenaire répond; jonction et envoi vers GHL |
| `GET /api/sante` | Vérifie jeton, locationId, KV, calendrier, confidentialité |
| `GET /api/diagnostic` | Crée un contact test et montre la réponse brute de GHL |

---

## Le calcul

```
Énoncé inversé (P2, V2)   score = 6 − réponse
Pilier, par personne      moyenne de ses énoncés            1,0 → 5,0
Pilier, couple            (A + B) / 2
Écart d'un pilier         moyenne de |A − B| sur ses énoncés

INDICE COUPLE INC.        (moyenne des 24 réponses − 1) / 4 × 100     0 → 100
INDICE D'ALIGNEMENT       100 − (moyenne des 12 écarts / 4 × 100)     0 → 100
```

**Sélection du pilier levier**

1. **Écart** — un pilier dont l'écart atteint 1,5 devient le levier (le plus grand l'emporte)
2. **Score** — sinon, le pilier au score le plus bas
3. **Départage** à 0,2 point ou moins : Sécurité › Réparation › Vision › Présence › Ambition

**Archétypes** — croisement Indice (seuil 65) × Alignement (seuil 78) :
L'Alliance · Le Décalage · La Traction · L'Apnée.

Les seuils sont à recalibrer après environ 200 réponses.

---

## Les 19 champs personnalisés GHL

Clés exactes. **Une clé qui ne correspond pas laisse le champ vide sans message d'erreur** —
GHL répond « 201 réussi » et jette la donnée.

`ci_indice` · `ci_alignement` · `ci_archetype` · `ci_palier` · `ci_levier` · `ci_regle_levier`
`ci_parcours` · `ci_date` · `ci_prenom_partenaire`
`ci_score_presence` · `ci_score_securite` · `ci_score_reparation` · `ci_score_vision` · `ci_score_ambition`
`ci_ecart_presence` · `ci_ecart_securite` · `ci_ecart_reparation` · `ci_ecart_vision` · `ci_ecart_ambition`

Type Nombre pour les deux indices, Texte pour le reste (les scores portent des décimales).

## Les tags (créés automatiquement par l'API)

`Couple Inc.` · `CI - Test commun` / `CI - Test individuel` · `CI - Levier <Pilier>` ·
`CI - Alliance` / `Décalage` / `Traction` / `Apnée` · `CI - Écart élevé` ·
`CI - Consentement marketing`

**Règle Loi 25 :** les séquences marketing se déclenchent **uniquement** sur
`CI - Consentement marketing`, jamais sur `Couple Inc.` seul. Le contact est créé dans tous les
cas — la finalité déclarée est de livrer le résultat — mais la case marketing est distincte et
facultative.

---

## Pièges connus

- **L'upsert GHL écrase les tags.** Le champ `tags` de `/contacts/upsert` remplace tous les tags
  existants du contact. Le Worker fait donc deux appels : `upsert` pour les champs, puis
  `/contacts/{id}/tags` pour ajouter les tags sans toucher aux autres. Ne pas « simplifier » ça.
- **L'entête `Version` de l'API GHL a changé.** Le Worker essaie `2021-07-28` puis `v3` et garde
  celle qui passe. En pratique, `2021-07-28` est acceptée.
- **Binding KV mal nommé.** S'il ne s'appelle pas exactement `KV`, seul le parcours asynchrone
  casse — le parcours « ensemble » continue de fonctionner, donc l'erreur passe inaperçue.
- **Lien partenaire : 60 jours.** C'est le TTL du KV.

---

## Vérifications déjà faites

Calcul testé sur une vingtaine de cas limites : énoncés inversés, les trois règles de sélection
du levier, les quatre archétypes à leurs seuils. Les trois parcours essayés de bout en bout sur
le Worker complet — page servie, lien partenaire, jonction des deux lectures, validation des
courriels, affichage mobile, comportement en cas de panne réseau. Aucune erreur JavaScript.

---

## Contenu

- `contenu/les-27-courriels.md` — les cinq séquences plus les deux courriels hors séquence,
  en texte brut, prêts à coller dans GHL.

Les guides complets (script du quiz, installation pas à pas, montage des workflows) vivent
comme documents dans le projet Claude « Couple Inc. ».

---

## Reste à faire

- [ ] Photo de Martine sur la page de résultat
- [ ] Lien de calendrier avec de vraies plages en soirée
- [ ] Politique de confidentialité : finalité, conservation, hébergement GHL, responsable
- [ ] Marque « Indice Couple inc.™ » à faire vérifier en propriété intellectuelle
- [ ] Les cinq workflows GHL + les deux hors séquence
- [ ] Un test avec un vrai couple d'entrepreneurs, pas les animateurs

---

*Couple inc. · Un programme Ax-One · S'élever à deux*
