/* ============================================================================
   INDICE COUPLE INC. — Worker Cloudflare
   Couple inc. · Un programme Ax-One
   ----------------------------------------------------------------------------
   Ce Worker fait trois choses :
     1. il calcule les indices (c'est la seule source de vérité du calcul);
     2. il crée ou met à jour le contact dans GoHighLevel, déjà taggé et rempli;
     3. il garde la lecture de la première personne pour la joindre à celle
        du partenaire quand il ou elle répond de son côté.

   Ce fichier contient AUSSI la page web. Vous n'avez donc qu'une seule chose
   à déposer dans Cloudflare, et STRICTEMENT RIEN à modifier ici.

   À CONFIGURER DANS LE TABLEAU DE BORD CLOUDFLARE :
     Variables secrètes (Settings > Variables and Secrets > type "Secret")
       GHL_TOKEN         le jeton de votre intégration privée GoHighLevel
     Variables normales (type "Text")
       GHL_LOCATION_ID   l'identifiant de votre sous-compte GHL
       CALENDRIER        le lien du calendrier de Martine
       CONFIDENTIALITE   le lien de votre politique de confidentialité
     Liaison KV (Bindings > KV namespace)
       KV                pointant vers un namespace nommé INDICE_COUPLE
     Domaine (Settings > Domains & Routes > Add > Custom domain)
       coupleinc.ax-one.ca
   ========================================================================== */

const API = "https://services.leadconnectorhq.com";
// GHL a fait évoluer son entête Version. On essaie les deux, dans l'ordre.
const VERSIONS = ["2021-07-28", "v3"];
const TTL_JOURS = 60; // durée de vie d'un lien partenaire

/* ---------------------------------------------------------------- énoncés */
const Q = [
  { id: "P1", p: "presence",   rev: false },
  { id: "S1", p: "securite",   rev: false },
  { id: "R1", p: "reparation", rev: false },
  { id: "V1", p: "vision",     rev: false },
  { id: "A1", p: "ambition",   rev: false },
  { id: "P2", p: "presence",   rev: true  },
  { id: "S2", p: "securite",   rev: false },
  { id: "R2", p: "reparation", rev: false },
  { id: "V2", p: "vision",     rev: true  },
  { id: "A3", p: "ambition",   rev: false },
  { id: "S3", p: "securite",   rev: false },
  { id: "A2", p: "ambition",   rev: false },
];

const PILIERS = ["presence", "securite", "reparation", "vision", "ambition"];
const NOM_PILIER = {
  presence: "Présence", securite: "Sécurité", reparation: "Réparation",
  vision: "Vision", ambition: "Ambition",
};
// ordre de départage quand deux piliers sont à égalité
const ORDRE = ["securite", "reparation", "vision", "presence", "ambition"];

const ARCHETYPE = {
  alliance: "L'Alliance", decalage: "Le Décalage",
  traction: "La Traction", apnee: "L'Apnée",
};

/* ----------------------------------------------------------------- calcul */
const moy = (t) => t.reduce((s, v) => s + v, 0) / t.length;
const score = (q, v) => (q.rev ? 6 - v : v);
const arrondi = (n) => Math.round(n * 10) / 10;

function valide(rep) {
  return Array.isArray(rep) && rep.length === Q.length &&
    rep.every((v) => Number.isInteger(v) && v >= 1 && v <= 5);
}

function calculer(repA, repB) {
  const duo = Array.isArray(repB);
  const parPilier = {};
  PILIERS.forEach((k) => (parPilier[k] = { a: [], b: [], ec: [] }));

  Q.forEach((q, i) => {
    const a = score(q, repA[i]);
    parPilier[q.p].a.push(a);
    if (duo) {
      const b = score(q, repB[i]);
      parPilier[q.p].b.push(b);
      parPilier[q.p].ec.push(Math.abs(a - b));
    }
  });

  const piliers = {};
  let toutes = [], ecarts = [];
  PILIERS.forEach((k) => {
    const A = moy(parPilier[k].a);
    const B = duo ? moy(parPilier[k].b) : null;
    const E = duo ? moy(parPilier[k].ec) : null;
    piliers[k] = {
      a: arrondi(A),
      b: duo ? arrondi(B) : null,
      couple: duo ? arrondi((A + B) / 2) : arrondi(A),
      ecart: duo ? arrondi(E) : null,
    };
    toutes = toutes.concat(parPilier[k].a, duo ? parPilier[k].b : []);
    if (duo) ecarts = ecarts.concat(parPilier[k].ec);
  });

  const indice = Math.round(((moy(toutes) - 1) / 4) * 100);
  const alignement = duo ? Math.round(100 - (moy(ecarts) / 4) * 100) : null;

  // pilier levier : règle 1 écart, règle 2 score, règle 3 départage
  let levier = null, parEcart = false;
  if (duo) {
    let plusGrand = -1;
    PILIERS.forEach((k) => {
      if (piliers[k].ecart >= 1.5 && piliers[k].ecart > plusGrand) {
        plusGrand = piliers[k].ecart; levier = k; parEcart = true;
      }
    });
  }
  if (!levier) {
    const mini = Math.min(...PILIERS.map((k) => piliers[k].couple));
    levier = ORDRE.find((k) => piliers[k].couple <= mini + 0.2);
  }

  let archetype = null;
  if (duo) {
    archetype = indice >= 65
      ? (alignement >= 78 ? "alliance" : "decalage")
      : (alignement >= 78 ? "traction" : "apnee");
  }

  const palier = indice < 50 ? "Sous tension"
    : indice < 75 ? "En développement" : "En raffinement";

  const ecartEleve = duo && PILIERS.some((k) => piliers[k].ecart >= 1.5);

  return { duo, indice, alignement, piliers, levier, parEcart, archetype, palier, ecartEleve };
}

/* -------------------------------------------------------------------- GHL */
function tags(res, consentement) {
  const t = ["Couple Inc."];
  t.push(res.duo ? "CI - Test commun" : "CI - Test individuel");
  t.push("CI - Levier " + NOM_PILIER[res.levier]);
  if (res.archetype) t.push("CI - " + ARCHETYPE[res.archetype].replace(/^L[ea']\s?/i, ""));
  if (res.ecartEleve) t.push("CI - Écart élevé");
  // Loi 25 : le courriel sert à livrer le résultat (finalité déclarée).
  // Les séquences marketing ne se déclenchent QUE sur ce tag-ci.
  if (consentement) t.push("CI - Consentement marketing");
  return t;
}

function champs(res, prenomPartenaire) {
  const c = [
    { key: "ci_indice",       fieldValue: String(res.indice) },
    { key: "ci_palier",       fieldValue: res.palier },
    { key: "ci_levier",       fieldValue: NOM_PILIER[res.levier] },
    { key: "ci_regle_levier", fieldValue: res.parEcart ? "écart" : "score" },
    { key: "ci_parcours",     fieldValue: res.duo ? "commun" : "individuel" },
    { key: "ci_date",         fieldValue: new Date().toISOString().slice(0, 10) },
  ];
  if (prenomPartenaire) c.push({ key: "ci_prenom_partenaire", fieldValue: prenomPartenaire });
  if (res.duo) {
    c.push({ key: "ci_alignement", fieldValue: String(res.alignement) });
    c.push({ key: "ci_archetype",  fieldValue: ARCHETYPE[res.archetype] });
  }
  PILIERS.forEach((k) => {
    c.push({ key: "ci_score_" + k, fieldValue: String(res.piliers[k].couple) });
    if (res.duo) c.push({ key: "ci_ecart_" + k, fieldValue: String(res.piliers[k].ecart) });
  });
  return c;
}

/* Appelle GHL en essayant les deux valeurs possibles de l'entête Version.
   Renvoie { ok, statut, data, version, corpsErreur }. */
async function ghl(env, chemin, corps) {
  let dernier = { ok: false, statut: 0, corpsErreur: "" };
  for (const v of VERSIONS) {
    const r = await fetch(API + chemin, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.GHL_TOKEN,
        Version: v,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(corps),
    });
    const txt = await r.text();
    if (r.ok) {
      let data = null;
      try { data = JSON.parse(txt); } catch (_) {}
      return { ok: true, statut: r.status, data, version: v };
    }
    dernier = { ok: false, statut: r.status, corpsErreur: txt.slice(0, 500), version: v };
    // 401/403 : le jeton ou ses permissions — inutile de réessayer avec l'autre version
    if (r.status === 401 || r.status === 403) break;
  }
  console.log("GHL " + chemin + " → " + dernier.statut + " " + dernier.corpsErreur);
  return dernier;
}

async function pousserGHL(env, { prenom, courriel, res, prenomPartenaire, source, consentement }) {
  if (!courriel) return { ok: false, raison: "aucun courriel" };

  // 1. upsert du contact — SANS les tags : le champ tags de l'upsert écrase
  //    tous les tags existants du contact, ce qu'on ne veut surtout pas.
  const up = await ghl(env, "/contacts/upsert", {
    locationId: env.GHL_LOCATION_ID,
    firstName: prenom || undefined,
    email: courriel,
    source: source || "Indice Couple inc.",
    customFields: champs(res, prenomPartenaire),
  });
  if (!up.ok) return up;

  // 2. ajout des tags — cet appel-là préserve les tags déjà en place
  const d = up.data || {};
  const id = (d.contact && d.contact.id) || d.id ||
             (d.contact && d.contact._id) || d._id || null;
  if (id) await ghl(env, "/contacts/" + id + "/tags", { tags: tags(res, consentement) });

  return { ok: true, contactId: id, version: up.version };
}


/* ═══════════════════════════════════════════════════════════════════════════
   LA PAGE WEB. Ne rien modifier ici : les deux liens se règlent dans les
   variables Cloudflare CALENDRIER et CONFIDENTIALITE.
   ═════════════════════════════════════════════════════════════════════════ */
const PAGE = `<title>Indice Couple inc. — Votre couple suit-il votre entreprise?</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400..700;1,400..600&family=Montserrat:wght@300;400;500;600&display=swap">
<style>
  /* ═══ Identité Couple inc. — sombre d'abord ═══ */
  :root{
    --ground:#16171A; --ground-2:#1B1C20; --surface:#212227; --surface-2:#26272C;
    --line:#33343A; --line-soft:#26272C;
    --ink:#F4F2F0; --ink-2:#C4C3C5; --muted:#8E8D91; --faint:#65646A;
    --rose:#D4799A; --rose-plein:#A94E6C; --rose-soft:rgba(212,121,154,.22);
    --btn-bg:#A94E6C; --btn-ink:#FFFFFF;
    --dot-a:#D4799A; --dot-b:#F4F2F0;
    --serif:"Playfair Display","Iowan Old Style",Georgia,serif;
    --sans:"Montserrat","Helvetica Neue",Arial,sans-serif;
  }
  @media (prefers-color-scheme: light){
    :root:not([data-theme="dark"]){
      --ground:#F1EDEA; --ground-2:#F7F4F2; --surface:#FFFFFF; --surface-2:#F8F5F3;
      --line:#DDD6D2; --line-soft:#E8E2DE;
      --ink:#16171A; --ink-2:#3C3D42; --muted:#75747A; --faint:#9A9498;
      --rose:#A0456A; --rose-plein:#A94E6C; --rose-soft:rgba(169,78,108,.16);
      --dot-a:#A94E6C; --dot-b:#16171A;
    }
  }
  :root[data-theme="light"]{
    --ground:#F1EDEA; --ground-2:#F7F4F2; --surface:#FFFFFF; --surface-2:#F8F5F3;
    --line:#DDD6D2; --line-soft:#E8E2DE;
    --ink:#16171A; --ink-2:#3C3D42; --muted:#75747A; --faint:#9A9498;
    --rose:#A0456A; --rose-plein:#A94E6C; --rose-soft:rgba(169,78,108,.16);
    --dot-a:#A94E6C; --dot-b:#16171A;
  }

  *{box-sizing:border-box}
  body{background:var(--ground);color:var(--ink);font-family:var(--sans);font-weight:300;font-size:16px;line-height:1.68;-webkit-font-smoothing:antialiased}
  p{margin:0 0 15px}
  :focus-visible{outline:1px solid var(--rose);outline-offset:4px}

  /* ─── marque ─── */
  .wm{font-family:var(--serif);letter-spacing:-.012em;line-height:1;white-space:nowrap}
  .wm b{font-weight:600}
  .wm em{font-style:normal;font-weight:400;font-size:.55em;margin-left:.16em;letter-spacing:0}

  .bar{border-bottom:1px solid var(--line-soft)}
  .bar-in{max-width:760px;margin:0 auto;padding:20px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px}
  .bar .wm{font-size:23px}
  .stepn{font-family:var(--sans);font-size:10.5px;font-weight:500;letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}
  .prog{height:1px;background:var(--line-soft)}
  .prog i{display:block;height:1px;background:var(--rose-plein);transition:width .4s cubic-bezier(.4,0,.2,1)}
  @media (prefers-reduced-motion:reduce){.prog i{transition:none}}

  main{max-width:760px;margin:0 auto;padding:0 24px 110px}
  .pane{padding:52px 0 0;animation:fade .4s ease both}
  @keyframes fade{from{opacity:0}to{opacity:1}}
  @media (prefers-reduced-motion:reduce){.pane{animation:none}}

  /* ─── typographie ─── */
  .eyebrow{font-family:var(--sans);font-size:10.5px;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:var(--rose);margin-bottom:22px}
  .eyebrow.q{color:var(--muted)}
  h1{font-family:var(--serif);font-weight:400;font-size:clamp(32px,5.6vw,52px);line-height:1.12;letter-spacing:-.015em;margin:0 0 22px;text-wrap:balance}
  h2{font-family:var(--serif);font-weight:400;font-size:clamp(26px,4.2vw,38px);line-height:1.16;letter-spacing:-.012em;margin:0 0 18px;text-wrap:balance}
  h3{font-family:var(--serif);font-weight:400;font-size:clamp(23px,3.4vw,30px);line-height:1.2;letter-spacing:-.01em;margin:0 0 14px}
  .rose{color:var(--rose)}
  .lede{font-size:18px;font-weight:300;color:var(--ink-2);max-width:56ch;line-height:1.6}
  .body{color:var(--ink-2);max-width:60ch;font-size:15.5px}
  .rule{width:52px;height:1px;background:var(--rose-plein);margin:26px 0}
  .rule.c{margin-left:auto;margin-right:auto}
  hr.sep{border:none;border-top:1px solid var(--line-soft);margin:52px 0 0}

  /* ─── boutons ─── */
  button{font-family:var(--sans);font-size:12px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;border:none;cursor:pointer;padding:16px 30px;background:var(--btn-bg);color:var(--btn-ink);border-radius:0;transition:opacity .15s}
  button:hover{opacity:.88}
  button.ghost{background:transparent;color:var(--ink-2);border:1px solid var(--line);padding:15px 29px}
  button.ghost:hover{border-color:var(--rose);color:var(--rose);opacity:1}
  button.txt{background:none;border:none;color:var(--muted);text-transform:none;letter-spacing:.01em;font-size:13px;font-weight:400;padding:10px 0;text-decoration:underline;text-underline-offset:4px}
  button.txt:hover{color:var(--rose)}
  .row{display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-top:34px}

  /* ─── choix des deux parcours ─── */
  .paths{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:34px}
  .path{background:var(--surface);border:1px solid var(--line);padding:28px 26px 26px;text-align:left;cursor:pointer;display:flex;flex-direction:column;gap:0;transition:border-color .18s;text-transform:none;letter-spacing:normal;font-weight:300}
  .path:hover{opacity:1}
  .path:hover{border-color:var(--rose)}
  .path .n{font-family:var(--serif);font-size:15px;color:var(--rose);letter-spacing:.02em}
  .path h4{font-family:var(--serif);font-weight:400;font-size:23px;line-height:1.22;margin:14px 0 10px;color:var(--ink);letter-spacing:-.01em}
  .path p{font-family:var(--sans);font-size:14px;font-weight:300;color:var(--ink-2);margin:0;line-height:1.6}
  .path .meta{font-family:var(--sans);font-size:10.5px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-top:18px}

  /* ─── règles ─── */
  ol.rules{list-style:none;counter-reset:r;margin:30px 0 0;padding:0}
  ol.rules li{counter-increment:r;display:grid;grid-template-columns:42px 1fr;gap:18px;padding:20px 0;border-top:1px solid var(--line-soft)}
  ol.rules li::before{content:"0" counter(r);font-family:var(--serif);font-size:15px;color:var(--rose);padding-top:2px}
  ol.rules b{font-family:var(--serif);font-weight:400;font-size:19px;display:block;margin-bottom:6px;color:var(--ink);line-height:1.3}
  ol.rules span{color:var(--ink-2);font-size:14.5px;font-weight:300;line-height:1.62}

  /* ─── énoncés ─── */
  .who{display:inline-flex;align-items:center;gap:10px;font-family:var(--sans);font-size:10.5px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:var(--ink-2)}
  .who i{width:8px;height:8px;border-radius:50%;background:var(--c);display:block}
  .stmt{font-family:var(--serif);font-weight:400;font-size:clamp(23px,3.6vw,33px);line-height:1.32;letter-spacing:-.012em;margin:26px 0 0;max-width:22ch;text-wrap:balance}
  .stmt.sm{font-size:clamp(19px,2.6vw,23px);color:var(--ink-2);max-width:32ch}
  .scale{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;margin:42px 0 0;background:var(--line-soft);border:1px solid var(--line-soft)}
  .scale button{background:var(--surface);color:var(--ink-2);padding:20px 8px;display:flex;flex-direction:column;gap:11px;align-items:center;text-transform:none;letter-spacing:0;font-weight:400;transition:background .15s,color .15s}
  .scale button:hover{background:var(--rose-plein);color:#fff;opacity:1}
  .scale button .n{font-family:var(--serif);font-size:24px;font-weight:400;line-height:1}
  .scale button .l{font-family:var(--sans);font-size:10px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;line-height:1.4;text-align:center;color:var(--muted)}
  .scale button:hover .l{color:rgba(255,255,255,.82)}
  .cap{font-size:13.5px;font-weight:300;color:var(--muted);margin:22px 0 0;max-width:54ch;line-height:1.6}

  /* ─── jauge d'écart ─── */
  .gauge{padding:18px 0;border-top:1px solid var(--line-soft)}
  .gauge:first-of-type{border-top:none}
  .glab{display:flex;justify-content:space-between;align-items:baseline;gap:16px;margin-bottom:6px}
  .gname{font-family:var(--serif);font-size:18px;font-weight:400;letter-spacing:-.005em}
  .gname.lev{color:var(--rose)}
  .gval{font-family:var(--sans);font-size:11px;font-weight:500;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);white-space:nowrap}
  .gval.hot{color:var(--rose)}
  .track{position:relative;height:30px}
  .track .rail{position:absolute;top:15px;left:0;right:0;height:1px;background:var(--line)}
  .track .tick{position:absolute;top:11px;width:1px;height:9px;background:var(--line);transform:translateX(-.5px)}
  .track .span{position:absolute;top:13px;height:5px;background:var(--rose-soft)}
  .track .dot{position:absolute;top:9px;width:13px;height:13px;border-radius:50%;transform:translateX(-6.5px)}
  .track .dot.a{background:var(--dot-a)}
  .track .dot.b{background:var(--dot-b);box-shadow:0 0 0 1px var(--ground)}
  .track .nm{position:absolute;top:-9px;transform:translateX(-50%);font-family:var(--sans);font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;white-space:nowrap}
  .track .nm.a{color:var(--dot-a)} .track .nm.b{color:var(--ink-2)}
  .legend{display:flex;gap:24px;flex-wrap:wrap;font-family:var(--sans);font-size:11px;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-top:20px;align-items:center}
  .legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:8px;vertical-align:-1px}
  .legend .sa{background:var(--dot-a)} .legend .sb{background:var(--dot-b);box-shadow:0 0 0 1px var(--line)}
  .legend .se{background:var(--rose-soft);border-radius:0;height:5px;width:20px;vertical-align:1px}

  .panel{background:var(--surface);border:1px solid var(--line);padding:30px 28px}
  .panel.rose{background:var(--rose-plein);border-color:var(--rose-plein);color:#fff}
  .panel.rose h2,.panel.rose h3{color:#fff}
  .panel.rose p{color:rgba(255,255,255,.86)}
  .panel.rose .eyebrow{color:rgba(255,255,255,.72)}
  .panel.rose button{background:#fff;color:var(--rose-plein)}
  .note{border-left:1px solid var(--rose-plein);padding:2px 0 2px 20px;color:var(--muted);font-size:13.5px;font-weight:300;max-width:62ch;line-height:1.66}
  .note p:last-child{margin-bottom:0}

  /* ─── résultat ─── */
  .scores{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line-soft);border:1px solid var(--line-soft);margin-top:30px}
  .scores > div{background:var(--surface);padding:28px 26px}
  .scores .k{font-family:var(--sans);font-size:10px;font-weight:600;letter-spacing:.19em;text-transform:uppercase;color:var(--muted)}
  .scores .v{font-family:var(--serif);font-size:56px;font-weight:400;line-height:1;margin:16px 0 8px;letter-spacing:-.02em}
  .scores .v small{font-size:19px;color:var(--faint)}
  .scores .t{font-family:var(--sans);font-size:11px;font-weight:600;letter-spacing:.13em;text-transform:uppercase;color:var(--rose)}
  .scores .t.n{color:var(--muted)}

  .arch{margin-top:30px;padding:38px 32px;background:var(--surface);border:1px solid var(--line);border-top:2px solid var(--rose-plein)}
  .arch .k{font-family:var(--sans);font-size:10px;font-weight:600;letter-spacing:.19em;text-transform:uppercase;color:var(--muted)}
  .arch .an{font-family:var(--serif);font-weight:400;font-size:clamp(38px,6.4vw,58px);line-height:1.02;letter-spacing:-.022em;margin:16px 0 0}
  .arch .hook{font-family:var(--serif);font-weight:400;font-style:italic;font-size:clamp(19px,2.7vw,24px);line-height:1.36;color:var(--rose);margin:16px 0 0;max-width:26ch}

  .seg{padding:28px 0;border-top:1px solid var(--line-soft)}
  .seg h5{font-family:var(--sans);font-size:10px;font-weight:600;letter-spacing:.19em;text-transform:uppercase;color:var(--rose);margin:0 0 14px}
  .seg p{color:var(--ink-2);max-width:60ch;font-size:15.5px;font-weight:300;line-height:1.7}
  .seg p:last-child{margin-bottom:0}
  .seg p.act{color:var(--ink);font-size:16.5px}
  .seg .lim{margin-top:18px;padding-left:20px;border-left:1px solid var(--line);color:var(--muted);font-size:14px;max-width:58ch}
  .voice{border:1px solid var(--line);padding:26px 28px;max-width:54ch;background:var(--surface-2)}
  .voice q{display:block;font-family:var(--serif);font-weight:400;font-style:italic;font-size:22px;line-height:1.42;quotes:"«\\00a0" "\\00a0»";color:var(--ink)}

  .martine{display:grid;grid-template-columns:92px 1fr;gap:0 24px;align-items:start}
  .martine .ph{aspect-ratio:1;border-radius:50%;background:var(--surface-2);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-family:var(--sans);font-size:9px;font-weight:600;letter-spacing:.13em;text-transform:uppercase;color:var(--faint);text-align:center;line-height:1.7}
  .martine blockquote{margin:0;font-family:var(--serif);font-style:italic;font-weight:400;font-size:19px;line-height:1.48;max-width:50ch}
  .martine .sig{font-family:var(--sans);font-size:10.5px;font-weight:600;letter-spacing:.17em;text-transform:uppercase;color:var(--muted);margin-top:18px}

  .fields{display:grid;gap:12px;margin:30px 0 0;max-width:430px}
  .fields .two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  input{width:100%;background:transparent;border:none;border-bottom:1px solid var(--line);padding:13px 2px;color:var(--ink);font-family:var(--sans);font-size:15px;font-weight:300}
  input:focus{border-bottom-color:var(--rose);outline:none}
  input::placeholder{color:var(--faint)}
  label.cb{display:grid;grid-template-columns:16px 1fr;gap:12px;align-items:start;font-size:13px;font-weight:300;color:var(--ink-2);line-height:1.6;margin-top:12px;cursor:pointer}
  label.cb input{width:auto;margin:4px 0 0;accent-color:var(--rose-plein)}
  .link-demo{font-family:var(--sans);font-size:12.5px;color:var(--muted);background:var(--surface-2);border:1px dashed var(--line);padding:14px 16px;word-break:break-all;margin-top:22px}

  .scroller{overflow-x:auto;border:1px solid var(--line-soft);margin-top:16px}
  table{border-collapse:collapse;width:100%;min-width:500px;font-size:13.5px;font-weight:300}
  th,td{text-align:left;padding:11px 16px;border-bottom:1px solid var(--line-soft)}
  th{font-family:var(--sans);font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);font-weight:600}
  tr:last-child td{border-bottom:none}
  td.pil{font-family:var(--serif);font-size:15px}
  td.va{color:var(--dot-a);font-weight:500} td.vb{color:var(--ink-2);font-weight:500}
  td.ve{color:var(--muted)} td.ve.hot{color:var(--rose);font-weight:500}

  footer{max-width:760px;margin:0 auto;padding:34px 24px 70px;border-top:1px solid var(--line-soft);display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap;align-items:center}
  footer .tag{font-family:var(--sans);font-size:10.5px;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:var(--muted)}
  footer .ax{display:flex;align-items:center;gap:10px;font-family:var(--sans);font-size:10px;font-weight:500;letter-spacing:.15em;text-transform:uppercase;color:var(--faint)}
  footer .ax img{width:26px;height:auto;display:block}

  @media (max-width:620px){
    .paths{grid-template-columns:1fr}
    .scale{grid-template-columns:repeat(5,1fr)}
    .scale button{padding:16px 2px}
    .scale button .l{display:none}
    .scores{grid-template-columns:1fr}
    .martine{grid-template-columns:1fr;gap:18px}
    .martine .ph{max-width:84px}
    .fields .two{grid-template-columns:1fr}
    .stmt{max-width:none}
  }

  a.btnlink{display:inline-block;font-family:var(--sans);font-size:12px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;background:#fff;color:var(--rose-plein);padding:16px 30px;text-decoration:none}
  a.btnlink:hover{opacity:.9}
  .cap a{color:var(--rose)}
</style>

<div class="bar"><div class="bar-in">
  <span class="wm"><b>Couple</b><em>inc.</em></span>
  <span class="stepn" id="steps"></span>
</div></div>
<div class="prog"><i id="prog" style="width:0"></i></div>
<main id="app"></main>
<footer>
  <span class="tag">S'élever à deux</span>
  <span class="ax"><img src="data:image/png;base64,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" alt="">Un programme Ax-One</span>
</footer>

<script>
(function(){
/* ══════════════════════════════════════════════════════════════════════════
   INDICE COUPLE INC. — page publique
   Couple inc. · Un programme Ax-One

   LES TROIS SEULES LIGNES À MODIFIER SONT JUSTE EN DESSOUS.
   ══════════════════════════════════════════════════════════════════════════ */
  var CONFIG = {
    WORKER: "",                       // même domaine que la page : rien à configurer
    CALENDRIER: "__CALENDRIER__",     // injecté par le Worker
    CONFIDENTIALITE: "__CONFIDENTIALITE__"
  };
/* ════════════════════════════════════════════════════════════════════════ */

  var PIL = {
    presence:{nom:"Présence", tag:"Se retrouver quand les rôles s'éteignent."},
    securite:{nom:"Sécurité", tag:"Ce qui peut se dire entre vous sans que ça coûte."},
    reparation:{nom:"Réparation", tag:"Revenir l'un vers l'autre — et savoir comment."},
    vision:{nom:"Vision", tag:"Vers quoi vous bâtissez — et comment vous tranchez."},
    ambition:{nom:"Ambition", tag:"Soutenir deux trajectoires sans les faire s'affronter."}
  };
  var ORDRE = ["securite","reparation","vision","presence","ambition"];

  var Q = [
    {id:"P1", p:"presence",  t:"Au cours des deux dernières semaines, nous avons passé au moins une soirée ensemble sans que l'entreprise entre dans la conversation."},
    {id:"S1", p:"securite",  t:"Il n'y a aucun sujet lié à l'entreprise que j'évite d'aborder avec l'autre pour ne pas déclencher une tension."},
    {id:"R1", p:"reparation",t:"La dernière fois qu'un désaccord d'affaires a créé une tension entre nous, nous en avons reparlé dans les 48 heures."},
    {id:"V1", p:"vision",    t:"Si nous écrivions chacun de notre côté à quoi devrait ressembler notre vie dans cinq ans, nos deux réponses se ressembleraient."},
    {id:"A1", p:"ambition",  t:"Nous avons la même tolérance au risque financier."},
    {id:"P2", p:"presence",  t:"Même quand nous sommes ensemble, je continue de gérer l'entreprise dans ma tête."},
    {id:"S2", p:"securite",  t:"Nous pouvons parler d'argent — revenus, salaires, dépenses, répartition — sans que ça tourne au conflit ou au silence."},
    {id:"R2", p:"reparation",t:"Celui qui fait le premier pas après une tension n'est pas toujours le même."},
    {id:"V2", p:"vision",    t:"Nos décisions importantes finissent souvent par se trancher selon celui qui insiste le plus."},
    {id:"A3", p:"ambition",  t:"Ma relation me donne de l'énergie et de la lucidité pour diriger — elle ne m'en coûte pas."},
    {id:"S3", p:"securite",  t:"Mes zones de décision dans l'entreprise sont assez claires pour que je sache ce que je peux trancher seul."},
    {id:"A2", p:"ambition",  t:"Si l'un de nous voulait ralentir, changer de rôle ou sortir de l'entreprise d'ici un an, nous saurions comment en parler."}
  ];
  var ECH = ["Pas du tout vrai","Plutôt faux","Mitigé","Plutôt vrai","Tout à fait vrai"];

  var TXT = {
    presence:{
      passe:"Le mode entreprise reste allumé plus longtemps qu'il ne le devrait. Vous êtes ensemble, mais pas toujours vraiment là — l'un de vous, ou les deux, continue de faire tourner l'entreprise dans sa tête alors que la soirée appartient déjà au couple.|Ce n'est pas un manque d'envie. C'est un système nerveux qui n'a jamais reçu le signal que la journée était finie.",
      cout:"Chaque fois que la présence se dilue, vous perdez plus qu'un moment de couple : vous perdez la fenêtre de récupération dont votre tête a besoin pour revenir le lendemain avec du recul et de bonnes décisions.|Un couple qui ne sait pas fermer le business fait tourner la même énergie, la même semaine, sur deux emplois à temps plein — et finit par plafonner les deux.",
      ecart:"Un écart important sur la Présence dit presque toujours la même chose : l'un des deux considère que vous décrochez très bien, l'autre est seul dans la pièce depuis un moment. Celui qui décroche le mieux est rarement celui qui souffre le plus du décrochage de l'autre — et c'est pour ça que le sujet n'est jamais arrivé sur la table.",
      geste:"Cette semaine, choisissez un moment quotidien où vous déposez les téléphones et où l'un de vous dit à voix haute : « Je ferme le business. » Le dire compte plus que le faire — c'est le signal, pas le geste, qui coupe le mode.",
      limite:"Un rituel tenu seul, sous la pression d'une entreprise qui ne s'arrête jamais, s'effrite en général en quelques semaines. Pas par manque de volonté : par manque de structure pour le porter.",
      question:"C'était quand, la dernière fois que tu m'as senti complètement là? Nomme le moment.",
      qcap:"Si aucun des deux ne peut nommer un moment précis, laissez le silence exister. C'est ça, la réponse."
    },
    securite:{
      passe:"Certains sujets s'abordent avec des détours, ou pas du tout — parce qu'ils touchent à l'argent, à la charge de travail ou à qui décide quoi. Les zones de décision ne sont pas toutes claires, et cette ambiguïté crée une tension de fond que personne ne nomme.|Le plus souvent, il n'y a pas de conflit ouvert. Il y a un contournement, tellement bien rodé qu'aucun des deux ne le remarque plus.",
      cout:"Un couple qui n'ose pas tout se dire ne prend jamais ses meilleures décisions d'affaires : il prend ses décisions les plus prudentes — celles qui évitent le prochain désaccord plutôt que celles qui font avancer l'entreprise.|Ce que vous ne vous dites pas ne disparaît pas. Ça ressort ailleurs, en général au pire moment, et déguisé en autre chose.",
      ecart:"Sur la Sécurité, un écart important est le signal le plus sérieux du test. Il ne veut pas dire que vous êtes en désaccord : il veut dire que l'un de vous se tait sans que l'autre le sache. Ce n'est pas une opinion différente, c'est une information qui manque à l'un des deux depuis un certain temps — et pendant ce temps, il prend des décisions à partir d'une lecture incomplète.",
      geste:"Cette semaine, nommez une seule zone où les rôles ou les décisions restent flous, et mettez-la sur la table. La consigne est stricte : vous la nommez, vous ne la tranchez pas. Vingt minutes, et on arrête.",
      limite:"Nommer une zone floue, c'est un début. Construire une vraie sécurité relationnelle sous la pression d'enjeux d'argent et de pouvoir demande à peu près toujours un tiers pour tenir le cadre — parce que dans ces conversations-là, celui qui l'emporte n'est pas celui qui a le meilleur argument, c'est celui qui a le plus de nerf.",
      question:"Est-ce qu'il y a un sujet que tu évites avec moi? Tu n'as pas à me dire lequel ce soir. Dis-moi juste s'il en existe un.",
      qcap:"La permission de ne pas répondre est ce qui rend la question possible. Ne la retirez pas."
    },
    reparation:{
      passe:"Sous la pression, l'équilibre se perd plus vite qu'il ne se retrouve. Une tension née d'une décision d'affaires a tendance à s'étirer : l'orgueil, la fatigue ou simplement le rythme de l'entreprise repoussent le moment de revenir l'un vers l'autre.|Et très souvent, c'est toujours le même qui revient.",
      cout:"Chaque tension non réparée reste active en arrière-plan. Elle ne disparaît pas : elle se déplace, et resurgit à la prochaine décision, déguisée en désaccord sur autre chose.|Un couple qui répare lentement finit par éviter des pans entiers de sujets d'affaires, simplement pour ne pas rouvrir la dernière tension. C'est comme ça qu'une entreprise perd des décisions qu'elle n'a même pas su qu'elle avait à prendre.",
      ecart:"Un écart sur la Réparation dit en général qui porte le travail de réconciliation. Celui qui répond haut trouve que ça finit toujours par se régler; celui qui répond bas est le plus souvent celui qui fait le pas chaque fois. Ce déséquilibre ne crée pas de conflit — il crée de la fatigue, puis du retrait. Et le retrait, lui, se voit trop tard.",
      geste:"La prochaine fois qu'une tension apparaît, engagez-vous à reprendre contact dans les 48 heures — pas pour régler le fond du désaccord, seulement pour rétablir le lien. Et si c'est toujours le même qui fait ce pas, c'est l'autre qui le fait cette fois-ci.",
      limite:"S'engager à faire le premier pas, c'est une intention. Savoir réparer — sans que l'un s'efface et sans que l'autre finisse par avoir raison — est une compétence, et les compétences se développent rarement seul, surtout sous fatigue.",
      question:"Après notre dernière tension, qui est revenu vers l'autre? Et avant celle-là?",
      qcap:"Deux réponses identiques suffisent à ouvrir la vraie conversation. Personne n'a besoin de la commenter."
    },
    vision:{
      passe:"La réussite professionnelle avance, mais la définition de ce qu'elle doit rendre possible dans votre vie est restée implicite. Les décisions importantes se prennent — pas toujours selon une façon partagée de trancher, parfois selon celui qui tient le plus longtemps.",
      cout:"Sans vision explicite et partagée, chaque décision d'affaires redevient une petite négociation à refaire. L'énergie qui devrait servir à faire grandir l'entreprise sert plutôt à faire grandir, année après année, un malentendu sur ce que vous visez vraiment.|Et le jour où l'entreprise atteint enfin l'objectif, il arrive que l'un des deux découvre que ce n'était pas le sien.",
      ecart:"Un écart sur la Vision est le plus discret et le plus coûteux du test. Il ne fait aucun bruit pendant des années, puis il rend une seule décision impossible — une vente, une expansion, un déménagement, un troisième enfant. À ce moment-là, ce n'est plus une conversation de vision : c'est un blocage, et il arrive avec dix ans d'intérêts.",
      geste:"Cette semaine, vingt minutes, une seule question : « Qu'est-ce que je veux que notre réussite rende possible dans notre vie, dans cinq ans? » Chacun écrit sa réponse seul avant de la lire à l'autre. L'ordre compte : écrire d'abord empêche le premier qui parle de fixer la réponse des deux.",
      limite:"Se poser la question, c'est nécessaire. Réaligner deux visions qui ont dérivé sans que personne s'en rende compte demande un cadre et un regard extérieur — parce que ce qui a dérivé, aucun des deux ne le voit de l'intérieur.",
      question:"Si l'entreprise doublait l'an prochain, qu'est-ce que ça changerait à ta semaine?",
      qcap:"Beaucoup plus révélatrice que « quels sont tes objectifs ». Elle force à traduire l'ambition en heures, et c'est là que les deux visions se séparent."
    },
    ambition:{
      passe:"Vos deux trajectoires n'avancent pas au même rythme, ou pas dans la même direction, et vous ne l'avez pas encore mis en mots. La tolérance au risque, l'appétit de croissance, l'envie de ralentir : ces différences sont normales.|Ce qui coûte, c'est qu'elles restent implicites — et qu'elles finissent par se régler en silence, une décision à la fois.",
      cout:"Deux choses arrivent quand l'ambition n'est pas explicite. Ou bien l'un freine sans le dire, et l'entreprise ralentit sans que personne comprenne pourquoi. Ou bien l'un accélère seul, et l'autre finit par se sentir spectateur de sa propre vie.|Dans les deux cas, ce n'est pas une question de motivation. C'est un accord qui n'a jamais été négocié.",
      ecart:"Sur l'Ambition, l'écart est l'information principale — davantage que le score. Deux personnes qui ne visent pas la même chose peuvent très bien diriger ensemble, à condition de le savoir. Ce qui casse les couples en affaires, ce n'est presque jamais la différence d'ambition. C'est de la découvrir cinq ans trop tard, au moment où elle coûte le plus cher à défaire.",
      geste:"Cette semaine, chacun répond à voix haute à une seule question : « Sur une échelle de 1 à 10, à quel point je veux que ça grandisse dans les trois prochaines années? » Aucun débat après. Vous nommez les deux chiffres, et vous les laissez exister dans la pièce.",
      limite:"Nommer les deux chiffres, c'est un excellent réflexe — et souvent un choc. Ce qui vient après (négocier deux appétits différents sans que l'un s'efface) est exactement le genre de conversation qui échoue quand elle se fait seul, tard le soir, après une journée de dix heures.",
      question:"Si je te disais que je veux ralentir l'an prochain, tu ressentirais quoi en premier?",
      qcap:"La première réaction est l'information. Pas la réponse raisonnable qui vient trois secondes après."
    }
  };

  var ARCH = {
    alliance:{nom:"L'Alliance", coord:"Indice ≥ 65 · Alignement ≥ 78", hook:"Vous construisez la même chose — et vous le savez tous les deux.", dit:"Rare. Votre relation est déjà une ressource pour l'entreprise, et vos deux lectures concordent.", risque:"Croire que c'est acquis. Un indice élevé mesure aujourd'hui, pas la prochaine phase de croissance."},
    decalage:{nom:"Le Décalage", coord:"Indice ≥ 65 · Alignement < 78", hook:"Vous allez bien. Mais pas tous les deux.", dit:"Le profil le plus délicat du test. Vos scores sont bons parce que l'un de vous tire la moyenne vers le haut — et pense donc que tout va bien.", risque:"Celui qui voit bas n'a aucune raison d'en parler : le couple « fonctionne ». Ça tient jusqu'à une décision importante."},
    traction:{nom:"La Traction", coord:"Indice < 65 · Alignement ≥ 78", hook:"Ça tire fort. Au moins, vous voyez la même chose.", dit:"La pression de l'entreprise dépasse ce que votre structure de couple peut absorber — et vous êtes deux à le mesurer pareil.", risque:"Attendre. Un couple aligné sur le constat repousse souvent l'action parce qu'il se sent solidaire dans la difficulté."},
    apnee:{nom:"L'Apnée", coord:"Indice < 65 · Alignement < 78", hook:"La charge a dépassé la structure — et vous ne mesurez pas la même chose.", dit:"Vous portez beaucoup, chacun de votre côté, et vous n'avez pas la même lecture de ce qui pèse.", risque:"Chaque conversation devient une négociation sur les faits avant même de porter sur le fond."}
  };

  var PALIER_TXT = {
    "Sous tension":"En ce moment, votre couple porte plus de charge qu'il n'en reçoit. Ce n'est pas un verdict sur votre relation : c'est une mesure de ce que la pression d'affaires lui prend en ce moment.",
    "En développement":"Votre couple soutient votre entreprise. Un pilier retient le reste — et c'est en général celui-là qui décide de la vitesse à laquelle vous pouvez encore grandir.",
    "En raffinement":"Votre couple est déjà un moteur de croissance. Ce qui reste à faire n'est pas une réparation : c'est aller chercher l'avantage complet."
  };
  var SECURITE_TXT = "Ce test mesure une dynamique de couple et de travail. Si votre situation implique de la violence, du contrôle ou une détresse importante, ce n'est pas un enjeu d'organisation à deux et ce résultat ne s'y applique pas — parlez-en à un professionnel.";

  var CLOTURE = {
    ecart:"Votre score sur ce pilier n'est pas bas. C'est votre écart qui l'est. Vous ne vivez pas la même relation sur cette dimension — et tant que cette différence n'est pas mise en mots, chacun de vous prend ses décisions à partir d'une lecture que l'autre ne partage pas. C'est précisément le type de situation qui se règle mieux à trois qu'à deux, parce qu'aucun des deux n'a intérêt à avoir raison.",
    bas:"Ce résultat n'est pas anodin. À ce niveau, ce pilier ne freine pas seulement votre couple : il freine directement les décisions de votre entreprise. C'est exactement le type de situation où un accompagnement structuré produit une différence rapide et mesurable — dans votre couple comme dans votre croissance.",
    moyen:"Vous avez déjà des bases solides. Ce pilier est simplement le frein qui vous empêche d'aller chercher votre prochain palier, autant en couple qu'en affaires. C'est le genre de levier qui se débloque plus vite et plus durablement avec un cadre qu'en s'y remettant seuls, chaque fois qu'on y repense.",
    haut:"Votre couple fonctionne déjà bien — ce pilier est votre prochaine marge de manœuvre, pas votre problème. Les couples qui vont chercher un accompagnement à ce stade ne le font pas parce que ça va mal : ils le font parce qu'ils veulent transformer un bon niveau en un véritable avantage de croissance."
  };

  /* ═══ état ═══ */
  var st = {ecran:"accueil", mode:"ensemble", phase:"a", noms:["",""],
            i:0, tour:"a", rep:[], jeton:null, res:null, erreur:"", occupe:false};

  function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
  function paras(s){return s.split("|").map(function(x){return "<p>"+x+"</p>";}).join("");}
  function pos(v){return (v-1)/4*100;}
  function nA(){return st.noms[0] || "Vous";}
  function nB(){return st.noms[1] || "Votre partenaire";}
  function vide(){var t=[],i;for(i=0;i<Q.length;i++)t.push({a:null,b:null});return t;}
  function courrielOk(e){return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/.test((e||"").trim());}
  function val(id){var e=document.getElementById(id);return e?e.value.trim():"";}
  function coche(id){var e=document.getElementById(id);return !!(e&&e.checked);}

  /* ═══ appels au Worker ═══ */
  function api(route, corps){
    var opts = corps
      ? {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(corps)}
      : {method:"GET"};
    return fetch(CONFIG.WORKER + route, opts).then(function(r){
      return r.json().then(function(d){
        if(!r.ok) throw new Error(d && d.erreur ? d.erreur : "Erreur " + r.status);
        return d;
      });
    });
  }

  function envoyer(route, corps, suite){
    st.occupe = true; render();
    api(route, corps).then(function(d){
      st.occupe = false;
      suite(d);
    }).catch(function(e){
      st.occupe = false;
      st.erreur = e.message || "La connexion n'a pas abouti.";
      st.reessayer = function(){ st.erreur=""; envoyer(route, corps, suite); };
      st.ecran = "erreur"; render();
    });
  }

  /* ═══ composants ═══ */
  function piste(a,b,noms){
    var pa=pos(a), pb=(b==null?null:pos(b));
    var h='<div class="track"><div class="rail"></div>';
    h+='<div class="tick" style="left:0"></div><div class="tick" style="left:25%"></div><div class="tick" style="left:50%"></div><div class="tick" style="left:75%"></div><div class="tick" style="left:100%"></div>';
    if(pb!=null) h+='<div class="span" style="left:'+Math.min(pa,pb)+'%;width:'+Math.abs(pa-pb)+'%"></div>';
    h+='<div class="dot a" style="left:'+pa+'%"></div>';
    if(pb!=null) h+='<div class="dot b" style="left:'+pb+'%"></div>';
    if(noms){
      h+='<span class="nm a" style="left:'+pa+'%">'+esc(nA())+'</span>';
      if(pb!=null) h+='<span class="nm b" style="left:'+pb+'%">'+esc(nB())+'</span>';
    }
    return h+"</div>";
  }
  function jauge(k,d,lev){
    var duo = d.b != null;
    var hot = duo && d.ecart >= 1.5;
    var v = duo ? (d.couple.toFixed(1)+"/5 · écart "+d.ecart.toFixed(1)) : (d.couple.toFixed(1)+"/5");
    return '<div class="gauge"><div class="glab"><span class="gname'+(k===lev?" lev":"")+'">'+PIL[k].nom+'</span>'
      + '<span class="gval'+(hot?" hot":"")+'">'+v+(k===lev?" · levier":"")+'</span></div>'
      + piste(d.a, duo?d.b:null, false) + '</div>';
  }
  function legende(duo){
    return '<div class="legend"><span><i class="sa"></i>'+esc(nA())+'</span>'
      + (duo?'<span><i class="sb"></i>'+esc(nB())+'</span><span><i class="se"></i>écart</span>':'')+'</div>';
  }
  function blocPilier(k,res,duo){
    var T=TXT[k];
    var e = (duo && res.parEcart) ? '<div class="seg"><h5>Ce que votre écart raconte</h5><p>'+T.ecart+'</p></div>' : '';
    return '<div class="eyebrow" style="margin-top:44px">'+(duo?"Votre levier à développer":"Votre pilier le plus exposé")+'</div>'
      + '<h2>'+PIL[k].nom+'</h2>'
      + '<p class="lede" style="font-family:var(--serif);font-style:italic;font-size:20px">'+PIL[k].tag+'</p>'
      + e
      + '<div class="seg"><h5>Ce qui se passe actuellement entre vous</h5>'+paras(T.passe)+'</div>'
      + '<div class="seg"><h5>Ce que ça coûte à votre croissance</h5>'+paras(T.cout)+'</div>'
      + '<div class="seg"><h5>Le geste qui ouvre la porte</h5><p class="act">'+T.geste+'</p>'
      + '<div class="lim"><p>'+T.limite+'</p></div></div>'
      + '<div class="seg"><h5>La question à poser à voix haute</h5><div class="voice"><q>'+T.question+'</q></div>'
      + '<p class="cap">'+T.qcap+'</p></div>';
  }
  function cloture(res){
    if(res.parEcart) return CLOTURE.ecart;
    var s = res.piliers[res.levier].couple;
    return s<2.5 ? CLOTURE.bas : (s<3.5 ? CLOTURE.moyen : CLOTURE.haut);
  }
  function blocMartine(res){
    var k = res.levier;
    return '<div class="panel" style="margin-top:16px">'
      + '<p class="body" style="margin-bottom:28px">'+cloture(res)+'</p>'
      + '<div class="martine"><div class="ph">Photo<br>Martine</div><div>'
      + '<blockquote>« J\\'accompagne des couples qui dirigent ensemble. Ils m\\'appellent presque jamais pour leur couple — ils m\\'appellent pour une décision qu\\'ils n\\'arrivent plus à prendre. C\\'est très souvent la même chose. »</blockquote>'
      + '<div class="sig">Martine — Couple inc.</div></div></div>'
      + '<div class="row"><a class="btnlink" href="'+esc(CONFIG.CALENDRIER)+'" target="_blank" rel="noopener">Parler de notre '+PIL[k].nom+' avec Martine</a></div>'
      + '<p class="cap">30 minutes, à deux, en visio. On lit votre Indice ensemble et vous repartez avec la prochaine conversation à avoir. Aucune présentation de programme.</p>'
      + '</div>';
  }
  function consentement(){
    return '<label class="cb"><input type="checkbox" id="cons"> J\\'accepte de recevoir les communications de Couple inc. par courriel. Je peux me désabonner en tout temps.</label>';
  }
  function mentionLegale(){
    return '<p class="cap">Votre courriel sert à vous livrer votre résultat. Vos réponses restent confidentielles et ne sont partagées avec aucun tiers. '
      + '<a href="'+esc(CONFIG.CONFIDENTIALITE)+'" target="_blank" rel="noopener">Politique de confidentialité</a>.</p>';
  }

  /* ═══ écrans ═══ */
  var app = document.getElementById("app");

  function chrome(){
    var pr=0, tx="";
    if(st.ecran==="q"){
      if(st.mode==="ensemble"){ pr=(st.i+(st.tour==="reveal"?1:(st.tour==="b"?.6:.2)))/Q.length*100; }
      else { pr=(st.i+1)/Q.length*100; }
      tx="Énoncé "+(st.i+1)+" / "+Q.length;
    }
    else if(st.ecran==="resultat"){pr=100;tx="Votre Indice";}
    else if(st.ecran==="resultatSolo"||st.ecran==="invite"){pr=70;tx="Moitié du résultat";}
    else if(st.ecran==="collect"){pr=92;tx="Presque terminé";}
    document.getElementById("prog").style.width=pr+"%";
    document.getElementById("steps").textContent=tx;
  }

  function render(){
    chrome();
    var f = {accueil:vAccueil, accueilPartenaire:vAccueilPartenaire, noms:vNoms,
             regles:vRegles, q:vQ, collect:vCollect, resultatSolo:vResultatSolo,
             invite:vInvite, resultat:vResultat, erreur:vErreur}[st.ecran];
    app.innerHTML = '<div class="pane">' + (st.occupe ? vAttente() : f()) + '</div>';
    window.scrollTo(0,0);
    var i, b = app.querySelectorAll("button");
    for(i=0;i<b.length;i++) b[i].addEventListener("click", clic);
    var n1=document.getElementById("n1"); if(n1) n1.focus();
  }

  function vAttente(){
    return '<div class="eyebrow">Un instant</div><h2>Nous calculons votre Indice…</h2>'
      + '<p class="body">Quelques secondes, ne fermez pas cette page.</p>';
  }
  function vErreur(){
    return '<div class="eyebrow">Connexion interrompue</div>'
      + '<h2>Vos réponses n\\'ont pas été perdues.</h2>'
      + '<p class="body">'+esc(st.erreur)+'</p>'
      + '<p class="body">Réessayez — tout ce que vous avez répondu est encore là.</p>'
      + '<div class="row"><button data-go="reessayer">Réessayer</button></div>';
  }

  function vAccueil(){
    return '<div class="eyebrow">Indice Couple inc.™ · 12 énoncés</div>'
      + '<h1>Votre entreprise a grandi.<br>Votre couple <span class="rose">a-t-il suivi</span>?</h1>'
      + '<div class="rule"></div>'
      + '<p class="lede">Vous partagez une entreprise, une ambition et une vie. Mais avez-vous développé votre façon d\\'être amoureux et associés au même rythme que votre chiffre d\\'affaires?</p>'
      + '<p class="body" style="margin-top:18px">Vous répondez chacun de votre côté, sans voir la réponse de l\\'autre. C\\'est là que ça devient intéressant : l\\'écart entre vos deux lectures est la chose que presque aucun couple en affaires n\\'a jamais mesurée.</p>'
      + '<div class="paths">'
      + '<button class="path" data-mode="ensemble"><span class="n">01</span><h4>Nous sommes ensemble, là, maintenant</h4><p>Vous répondez chacun votre tour sur le même appareil. Les deux réponses se révèlent après chaque énoncé.</p><span class="meta">8 minutes · à deux</span></button>'
      + '<button class="path" data-mode="solo"><span class="n">02</span><h4>Je commence seul, de mon côté</h4><p>Vous répondez maintenant et recevez votre lecture. Votre partenaire répond ensuite, quand ça lui convient.</p><span class="meta">4 minutes · maintenant</span></button>'
      + '</div>';
  }

  function vAccueilPartenaire(){
    return '<div class="eyebrow">Invitation de '+esc(nA())+'</div>'
      + '<h1>'+esc(nA())+' a répondu.<br>Il manque <span class="rose">votre lecture</span>.</h1>'
      + '<div class="rule"></div>'
      + '<p class="lede">Douze énoncés, quatre minutes. Vous ne verrez pas les réponses de '+esc(nA())+' — c\\'est exactement ce qui rend le résultat utile.</p>'
      + '<p class="body">À la fin, vous découvrirez tous les deux votre Indice commun : où votre dynamique est solide, et surtout l\\'écart entre vos deux façons de voir la même relation.</p>'
      + '<div class="row"><button data-go="regles">Commencer</button></div>';
  }

  function vNoms(){
    var solo = st.mode==="solo";
    return '<div class="eyebrow">Avant de commencer</div>'
      + '<h2>'+(solo?"Vous êtes deux, même si vous répondez seul.":"Comment vous appelez-vous?")+'</h2>'
      + '<p class="body">'+(solo?"Le prénom de votre partenaire sert à personnaliser son invitation et votre résultat commun.":"Les prénoms servent à distinguer vos deux lectures tout au long du test.")+'</p>'
      + '<div class="fields"><div class="two">'
      + '<input type="text" id="n1" maxlength="18" placeholder="'+(solo?"Votre prénom":"Premier prénom")+'" value="'+esc(st.noms[0])+'">'
      + '<input type="text" id="n2" maxlength="18" placeholder="'+(solo?"Prénom de votre partenaire":"Second prénom")+'" value="'+esc(st.noms[1])+'"></div></div>'
      + '<div class="row"><button data-noms="1">Continuer</button></div>';
  }

  function vRegles(){
    var seul = st.mode!=="ensemble";
    var r4 = seul
      ? '<li><b>N\\'en parlez pas '+(st.mode==="partenaire"?"avec "+esc(nA()):"à "+esc(nB()))+' avant d\\'avoir terminé.</b><span>Une réponse influencée ne mesure plus rien. C\\'est la seule consigne qui compte vraiment.</span></li>'
      : '<li><b>Quand vos réponses s\\'écartent, ne discutez pas tout de suite.</b><span>Notez-le et passez au suivant. Le résultat vous dira lequel de ces écarts compte vraiment.</span></li>';
    return '<div class="eyebrow">Quatre règles</div>'
      + '<h2>Ce n\\'est pas un test de personnalité.</h2>'
      + '<p class="body">C\\'est un instantané de votre dynamique actuelle — et il se périme. Refaites-le dans six mois, il ne dira pas la même chose.</p>'
      + '<ol class="rules">'
      + '<li><b>'+(seul?"Répondez seul, sans consulter l'autre.":"Répondez chacun, sans voir la réponse de l'autre.")+'</b><span>'+(seul?"Vous découvrirez les deux lectures ensemble, une fois que chacun aura terminé de son côté.":"Vous découvrirez les deux réponses en même temps, après chaque énoncé. Si vous répondez ensemble, le test ne mesure plus rien.")+'</span></li>'
      + '<li><b>Première réaction, pas la bonne réponse.</b><span>Il n\\'y a pas de bonne réponse. Il y a la vôtre, et celle de l\\'autre.</span></li>'
      + '<li><b>Décrivez ce qui est, pas ce que vous voulez.</b><span>Répondez pour les trois derniers mois, pas pour le couple que vous aimeriez être.</span></li>'
      + r4 + '</ol>'
      + '<div class="row"><button data-go="q">Commencer</button></div>';
  }

  function echelle(){
    var h='<div class="scale">',v;
    for(v=1;v<=5;v++) h+='<button data-v="'+v+'"><span class="n">'+v+'</span><span class="l">'+ECH[v-1]+'</span></button>';
    return h+"</div>";
  }

  function vQ(){
    var q=Q[st.i];
    var head='<div class="eyebrow q">'+PIL[q.p].nom+' — énoncé '+(st.i+1)+' sur '+Q.length+'</div>';

    if(st.mode!=="ensemble"){
      var qui = st.mode==="partenaire" ? nB() : nA();
      var col = st.mode==="partenaire" ? "var(--ink-2)" : "var(--dot-a)";
      return head + '<span class="who" style="--c:'+col+'"><i></i>'+esc(qui)+'</span>'
        + '<p class="stmt">'+q.t+'</p>' + echelle();
    }
    if(st.tour==="a"||st.tour==="b"){
      var w = st.tour==="a"?nA():nB();
      var c = st.tour==="a"?"var(--dot-a)":"var(--ink-2)";
      return head + '<span class="who" style="--c:'+c+'"><i></i>Au tour de '+esc(w)+'</span>'
        + '<p class="stmt">'+q.t+'</p>' + echelle()
        + '<p class="cap">Votre réponse restera masquée jusqu\\'à ce que '+esc(st.tour==="a"?nB():nA())+' ait répondu.</p>';
    }
    if(st.tour==="passe"){
      return head + '<h2 style="margin-top:26px">Passez l\\'appareil à '+esc(nB())+'.</h2>'
        + '<p class="body">La réponse de '+esc(nA())+' est enregistrée et masquée. '+esc(nB())+' répond au même énoncé, sans la voir.</p>'
        + '<div class="row"><button data-go="tourb">Je suis '+esc(nB())+'</button></div>';
    }
    var r=st.rep[st.i], e=Math.abs(r.a-r.b);
    var mot = e===0?"Vous avez répondu la même chose.":(e===1?"Un écart d'un point.":"Un écart de "+e+" points.");
    return head + '<p class="stmt sm">'+q.t+'</p>'
      + '<div class="panel" style="margin-top:30px"><div style="padding-top:12px">'+piste(r.a,r.b,true)+'</div>'
      + '<p style="font-family:var(--serif);font-size:21px;margin:18px 0 0">'+mot+'</p></div>'
      + '<div class="row"><button data-go="suite">'+(st.i===Q.length-1?"Voir notre Indice":"Énoncé suivant")+'</button>'
      + '<button class="txt" data-go="refaire">Refaire cet énoncé</button></div>';
  }

  function vCollect(){
    if(st.mode==="ensemble"){
      return '<div class="eyebrow">Votre Indice Couple inc.™ est prêt</div>'
        + '<h2>Où envoyons-nous votre résultat?</h2>'
        + '<p class="body">Vous découvrirez l\\'archétype de votre couple, vos deux indices, le pilier qui mérite votre attention et le premier geste à poser cette semaine.</p>'
        + '<div class="fields"><div class="two">'
        + '<input type="email" id="e1" placeholder="Courriel de '+esc(nA())+'">'
        + '<input type="email" id="e2" placeholder="Courriel de '+esc(nB())+' — facultatif"></div>'
        + consentement() + '</div>'
        + '<div class="row"><button data-go="envoiDuo">Voir notre résultat</button></div>'
        + mentionLegale();
    }
    if(st.mode==="partenaire"){
      return '<div class="eyebrow">Dernière étape</div>'
        + '<h2>Où envoyons-nous votre Indice commun?</h2>'
        + '<p class="body">'+esc(nA())+' recevra le même résultat de son côté.</p>'
        + '<div class="fields"><input type="email" id="e1" placeholder="Votre courriel">'
        + consentement() + '</div>'
        + '<div class="row"><button data-go="envoiJoin">Voir notre Indice commun</button></div>'
        + mentionLegale();
    }
    return '<div class="eyebrow">Votre lecture est prête</div>'
      + '<h2>Où envoyons-nous votre résultat?</h2>'
      + '<p class="body">Vous recevrez votre lecture immédiatement, et le lien à transmettre à '+esc(nB())+'.</p>'
      + '<div class="fields"><input type="email" id="e1" placeholder="Votre courriel">'
      + consentement() + '</div>'
      + '<div class="row"><button data-go="envoiSolo">Voir ma lecture</button></div>'
      + mentionLegale();
  }

  function vResultatSolo(){
    var res = st.res, k = res.levier, i, profil="";
    for(i=0;i<ORDRE.length;i++) profil += jauge(ORDRE[i], res.piliers[ORDRE[i]], k);
    return '<div class="eyebrow">Votre lecture — '+esc(nA())+'</div>'
      + '<h1>Votre moitié de l\\'Indice.</h1><div class="rule"></div>'
      + '<div class="scores">'
      + '<div><div class="k">Votre indice personnel</div><div class="v">'+res.indice+'<small>/100</small></div><div class="t">'+res.palier+'</div></div>'
      + '<div><div class="k">Indice d\\'alignement</div><div class="v" style="color:var(--faint)">—</div><div class="t n">En attente de '+esc(nB())+'</div></div>'
      + '</div>'
      + '<p class="body" style="margin-top:24px">'+PALIER_TXT[res.palier]+'</p>'
      + (res.palier==="Sous tension" ? '<div class="note" style="margin-top:18px"><p>'+SECURITE_TXT+'</p></div>' : '')
      + '<hr class="sep">'
      + '<div class="eyebrow" style="margin-top:34px">Vos cinq piliers, selon votre lecture</div>'
      + profil + legende(false)
      + blocPilier(k,res,false)
      + '<hr class="sep">'
      + '<div class="panel rose" style="margin-top:34px">'
      + '<div class="eyebrow">Ce qui vous manque</div>'
      + '<h3 style="font-size:30px">La partie la plus révélatrice de votre Indice n\\'existe pas encore.</h3>'
      + '<p>Ce que vous venez de lire est votre version. L\\'écart entre votre lecture et celle de '+esc(nB())+' — la seule information qu\\'aucun de vous deux ne peut produire seul — demande sa réponse. Quatre minutes, de son côté, quand ça lui convient.</p>'
      + '<p style="margin-bottom:0">Vous n\\'avez pas votre archétype non plus : il se calcule sur vos deux lectures.</p>'
      + '<div class="row"><button data-go="invite">Obtenir le lien de '+esc(nB())+'</button></div>'
      + '</div>';
  }

  function vInvite(){
    var lien = location.origin + location.pathname + "?r=" + st.jeton;
    return '<div class="eyebrow">Invitation</div>'
      + '<h2>Le lien de '+esc(nB())+' est prêt.</h2>'
      + '<p class="body">Envoyez-le-lui par message texte ou par courriel. '+esc(nB())+' répond de son côté, sans jamais voir vos réponses — et vous recevez tous les deux votre Indice commun dès que c\\'est fait.</p>'
      + '<div class="link-demo" id="lien">'+esc(lien)+'</div>'
      + '<div class="row"><button data-copie="'+esc(lien)+'">Copier le lien</button>'
      + '<button class="ghost" data-sms="'+esc(lien)+'">Envoyer par message</button></div>'
      + '<p class="cap">Message suggéré : « J\\'ai fait un test de 4 minutes sur nous deux. Il me manque ta moitié pour avoir le résultat. »</p>'
      + '<p class="cap">Le lien reste valide 60 jours.</p>';
  }

  function vResultat(){
    var res = st.res, a = ARCH[res.archetype], k = res.levier, i, profil="";
    for(i=0;i<ORDRE.length;i++) profil += jauge(ORDRE[i], res.piliers[ORDRE[i]], k);
    return '<div class="eyebrow">Votre Indice Couple inc.™</div>'
      + '<div class="arch"><div class="k">'+a.coord+'</div><div class="an">'+a.nom+'</div><p class="hook">'+a.hook+'</p></div>'
      + '<div class="scores">'
      + '<div><div class="k">Indice Couple inc.</div><div class="v">'+res.indice+'<small>/100</small></div><div class="t">'+res.palier+'</div></div>'
      + '<div><div class="k">Indice d\\'alignement</div><div class="v">'+res.alignement+'<small>/100</small></div><div class="t">'+(res.alignement>=78?"Lectures concordantes":"Deux lectures différentes")+'</div></div>'
      + '</div>'
      + '<p class="body" style="margin-top:26px">'+PALIER_TXT[res.palier]+'</p>'
      + '<p class="body">'+a.dit+'</p>'
      + '<p class="body"><b style="color:var(--ink);font-weight:500">Le risque —</b> '+a.risque+'</p>'
      + (res.palier==="Sous tension" ? '<div class="note" style="margin-top:8px"><p>'+SECURITE_TXT+'</p></div>' : '')
      + '<hr class="sep">'
      + '<div class="eyebrow" style="margin-top:34px">Le profil de vos cinq piliers</div>'
      + profil + legende(true)
      + blocPilier(k,res,true)
      + '<hr class="sep" style="margin-top:20px">'
      + blocMartine(res);
  }

  /* ═══ interactions ═══ */
  function clic(e){
    var t=e.currentTarget, g=t.getAttribute("data-go"), v=t.getAttribute("data-v"),
        m=t.getAttribute("data-mode"), cp=t.getAttribute("data-copie"), sms=t.getAttribute("data-sms");

    if(cp){
      if(navigator.clipboard) navigator.clipboard.writeText(cp);
      t.textContent = "Lien copié";
      return;
    }
    if(sms){
      location.href = "sms:?&body=" + encodeURIComponent(
        "J'ai fait un test de 4 minutes sur nous deux. Il me manque ta moitié pour avoir le résultat : " + sms);
      return;
    }
    if(m){ st.mode=m; st.ecran="noms"; render(); return; }

    if(t.getAttribute("data-noms")){
      st.noms[0]=val("n1") || (st.mode==="solo"?"Vous":"Personne 1");
      st.noms[1]=val("n2") || (st.mode==="solo"?"Votre partenaire":"Personne 2");
      st.ecran="regles"; render(); return;
    }

    if(v){
      v=parseInt(v,10);
      if(st.mode==="ensemble"){
        if(st.tour==="a"){ st.rep[st.i].a=v; st.tour="passe"; }
        else { st.rep[st.i].b=v; st.tour="reveal"; }
        render(); return;
      }
      st.rep[st.i][st.mode==="partenaire"?"b":"a"]=v;
      if(st.i===Q.length-1) st.ecran="collect"; else st.i++;
      render(); return;
    }

    if(g==="regles"){ st.ecran="regles"; render(); return; }
    if(g==="q"){ st.ecran="q"; st.i=0; st.tour="a"; if(!st.rep.length) st.rep=vide(); render(); return; }
    if(g==="tourb"){ st.tour="b"; render(); return; }
    if(g==="refaire"){ st.tour="a"; render(); return; }
    if(g==="suite"){ if(st.i===Q.length-1) st.ecran="collect"; else { st.i++; st.tour="a"; } render(); return; }
    if(g==="invite"){ st.ecran="invite"; render(); return; }
    if(g==="reessayer"){ if(st.reessayer) st.reessayer(); return; }

    if(g==="envoiDuo"){
      var e1=val("e1"), e2=val("e2");
      if(!courrielOk(e1)){ signaler("e1","Entrez un courriel valide pour recevoir votre résultat."); return; }
      envoyer("/api/duo", {
        prenomA:st.noms[0], prenomB:st.noms[1], courrielA:e1,
        courrielB:courrielOk(e2)?e2:"", consentement:coche("cons"),
        repA:st.rep.map(function(r){return r.a;}), repB:st.rep.map(function(r){return r.b;})
      }, function(d){ st.res=d.resultat; st.ecran="resultat"; render(); });
      return;
    }
    if(g==="envoiSolo"){
      var s1=val("e1");
      if(!courrielOk(s1)){ signaler("e1","Entrez un courriel valide pour recevoir votre lecture."); return; }
      envoyer("/api/solo", {
        prenomA:st.noms[0], prenomB:st.noms[1], courrielA:s1, consentement:coche("cons"),
        repA:st.rep.map(function(r){return r.a;})
      }, function(d){ st.res=d.resultat; st.jeton=d.jeton; st.ecran="resultatSolo"; render(); });
      return;
    }
    if(g==="envoiJoin"){
      var j1=val("e1");
      if(!courrielOk(j1)){ signaler("e1","Entrez un courriel valide pour recevoir votre Indice commun."); return; }
      envoyer("/api/join", {
        jeton:st.jeton, courrielB:j1, consentement:coche("cons"),
        repB:st.rep.map(function(r){return r.b;})
      }, function(d){ st.res=d.resultat; st.ecran="resultat"; render(); });
      return;
    }
  }

  function signaler(id, message){
    var e=document.getElementById(id); if(!e) return;
    e.style.borderBottomColor="var(--rose)"; e.focus();
    var p=document.getElementById("msg-erreur");
    if(!p){ p=document.createElement("p"); p.id="msg-erreur"; p.className="cap";
      p.style.color="var(--rose)"; e.parentNode.appendChild(p); }
    p.textContent=message;
  }

  /* ═══ démarrage : lien du partenaire ? ═══ */
  var t = new URLSearchParams(location.search).get("r");
  if(t){
    st.occupe = true;
    api("/api/lien?t=" + encodeURIComponent(t)).then(function(d){
      st.occupe=false; st.mode="partenaire"; st.jeton=t;
      st.noms=[d.prenomA||"Votre partenaire", d.prenomB||"Vous"];
      st.rep=vide(); st.ecran="accueilPartenaire"; render();
    }).catch(function(){
      st.occupe=false; st.ecran="accueil"; render();
    });
  }
  render();
})();
</script>
`;

/* ------------------------------------------------------------------ HTTP */
// La page et l'API vivent sur le même domaine : aucun problème d'origine croisée.
function cors() {
  return {
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
const json = (env, data, statut = 200) =>
  new Response(JSON.stringify(data), {
    status: statut,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors() },
  });

function jeton() {
  const o = new Uint8Array(9);
  crypto.getRandomValues(o);
  return [...o].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 14);
}

const courrielValide = (e) => typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });

    /* ---- mode ENSEMBLE : les deux lectures arrivent d'un coup ---------- */
    if (url.pathname === "/api/duo" && request.method === "POST") {
      const d = await request.json().catch(() => ({}));
      if (!valide(d.repA) || !valide(d.repB)) return json(env, { erreur: "réponses invalides" }, 400);

      const res = calculer(d.repA, d.repB);
      if (courrielValide(d.courrielA)) {
        await pousserGHL(env, { prenom: d.prenomA, courriel: d.courrielA, res,
          prenomPartenaire: d.prenomB, consentement: !!d.consentement,
          source: "Indice Couple inc. — ensemble" });
      }
      if (courrielValide(d.courrielB)) {
        await pousserGHL(env, { prenom: d.prenomB, courriel: d.courrielB, res,
          prenomPartenaire: d.prenomA, consentement: !!d.consentement,
          source: "Indice Couple inc. — ensemble (partenaire)" });
      }
      return json(env, { resultat: res });
    }

    /* ---- mode SOLO, première lecture ---------------------------------- */
    if (url.pathname === "/api/solo" && request.method === "POST") {
      const d = await request.json().catch(() => ({}));
      if (!valide(d.repA)) return json(env, { erreur: "réponses invalides" }, 400);

      const res = calculer(d.repA, null);
      const t = jeton();
      await env.KV.put("r:" + t, JSON.stringify({
        repA: d.repA, prenomA: d.prenomA || "", prenomB: d.prenomB || "",
        courrielA: courrielValide(d.courrielA) ? d.courrielA : "",
        consentement: !!d.consentement, cree: Date.now(),
      }), { expirationTtl: TTL_JOURS * 86400 });

      if (courrielValide(d.courrielA)) {
        await pousserGHL(env, { prenom: d.prenomA, courriel: d.courrielA, res,
          prenomPartenaire: d.prenomB, consentement: !!d.consentement,
          source: "Indice Couple inc. — individuel" });
      }
      return json(env, { resultat: res, jeton: t });
    }

    /* ---- le partenaire ouvre son lien --------------------------------- */
    if (url.pathname === "/api/lien" && request.method === "GET") {
      const t = url.searchParams.get("t") || "";
      const brut = await env.KV.get("r:" + t);
      if (!brut) return json(env, { erreur: "lien expiré ou introuvable" }, 404);
      const d = JSON.parse(brut);
      // on ne renvoie JAMAIS les réponses de la première personne au navigateur
      return json(env, { valide: true, prenomA: d.prenomA, prenomB: d.prenomB, fait: !!d.fait });
    }

    /* ---- le partenaire répond : on joint les deux lectures ------------ */
    if (url.pathname === "/api/join" && request.method === "POST") {
      const d = await request.json().catch(() => ({}));
      const brut = await env.KV.get("r:" + d.jeton);
      if (!brut) return json(env, { erreur: "lien expiré ou introuvable" }, 404);
      if (!valide(d.repB)) return json(env, { erreur: "réponses invalides" }, 400);

      const a = JSON.parse(brut);
      const res = calculer(a.repA, d.repB);

      if (courrielValide(a.courrielA)) {
        await pousserGHL(env, { prenom: a.prenomA, courriel: a.courrielA, res,
          prenomPartenaire: a.prenomB, consentement: !!a.consentement,
          source: "Indice Couple inc. — commun" });
      }
      if (courrielValide(d.courrielB)) {
        await pousserGHL(env, { prenom: a.prenomB, courriel: d.courrielB, res,
          prenomPartenaire: a.prenomA, consentement: !!d.consentement,
          source: "Indice Couple inc. — commun (partenaire)" });
      }

      a.fait = true;
      await env.KV.put("r:" + d.jeton, JSON.stringify(a), { expirationTtl: TTL_JOURS * 86400 });
      return json(env, { resultat: res, prenomA: a.prenomA, prenomB: a.prenomB });
    }

    /* ---- vérification rapide que le Worker répond --------------------- */
    if (url.pathname === "/api/sante") {
      let kvOk = false;
      try { await env.KV.put("sante", "1", { expirationTtl: 60 }); kvOk = true; } catch (_) {}
      return json(env, {
        worker: "ok",
        jeton_ghl_present: !!env.GHL_TOKEN,
        location_id_present: !!env.GHL_LOCATION_ID,
        kv_fonctionne: kvOk,
        calendrier_configure: !!env.CALENDRIER,
        confidentialite_configuree: !!env.CONFIDENTIALITE,
      });
    }

    /* ---- test réel vers GHL : crée un contact bidon et montre la réponse
            brute. Ouvrir /api/diagnostic dans le navigateur, puis supprimer
            le contact « diagnostic@coupleinc.test » dans GHL.  ------------ */
    if (url.pathname === "/api/diagnostic") {
      const faux = calculer([3,3,3,3,3,3,3,3,3,3,3,3], [4,2,4,2,4,2,4,2,4,2,4,2]);
      const up = await ghl(env, "/contacts/upsert", {
        locationId: env.GHL_LOCATION_ID,
        firstName: "Diagnostic",
        email: "diagnostic@coupleinc.test",
        source: "Diagnostic Indice Couple inc.",
        customFields: champs(faux, "Test"),
      });
      let ajoutTags = null, id = null;
      if (up.ok) {
        const d = up.data || {};
        id = (d.contact && d.contact.id) || d.id || (d.contact && d.contact._id) || d._id || null;
        if (id) ajoutTags = await ghl(env, "/contacts/" + id + "/tags", { tags: tags(faux, true) });
      }
      return json(env, {
        upsert: { ok: up.ok, statut: up.statut, version_acceptee: up.version || null,
                  erreur: up.corpsErreur || null },
        contact_id: id,
        ajout_tags: ajoutTags ? { ok: ajoutTags.ok, statut: ajoutTags.statut,
                                  erreur: ajoutTags.corpsErreur || null } : null,
        calcul_test: { indice: faux.indice, alignement: faux.alignement,
                       levier: NOM_PILIER[faux.levier], archetype: ARCHETYPE[faux.archetype] },
        rappel: "Supprimez le contact diagnostic@coupleinc.test dans GHL une fois le test réussi.",
      });
    }

    /* ---- tout le reste : on sert la page ------------------------------ */
    if (url.pathname.startsWith("/api/")) return json(env, { erreur: "route inconnue" }, 404);

    const doc = "<!doctype html><html lang=\"fr\"><head><meta charset=\"utf-8\">"
      + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
      + "<meta name=\"description\" content=\"Votre entreprise a grandi. Votre couple a-t-il suivi? "
      + "Douze énoncés, deux lectures, un Indice. Couple inc., un programme Ax-One.\">"
      + "<meta name=\"robots\" content=\"index,follow\">"
      + "<meta property=\"og:type\" content=\"website\">"
      + "<meta property=\"og:site_name\" content=\"Couple inc.\">"
      + "<meta property=\"og:title\" content=\"Votre entreprise a grandi. Votre couple a-t-il suivi?\">"
      + "<meta property=\"og:description\" content=\"Douze énoncés, deux lectures. Découvrez votre Indice Couple inc. et l'écart entre vos deux façons de voir la même relation.\">"
      + "<meta property=\"og:url\" content=\"" + url.origin + url.pathname + "\">"
      + "<meta name=\"twitter:card\" content=\"summary_large_image\">"
      + "<style>:root{color-scheme:dark light}body{margin:0;padding:0}img{max-width:100%}</style>"
      + "</head><body>"
      + PAGE
          .split("__CALENDRIER__").join(env.CALENDRIER || "#")
          .split("__CONFIDENTIALITE__").join(env.CONFIDENTIALITE || "#")
      + "</body></html>";

    return new Response(doc, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
      },
    });
  },
};
