/* ══════════════════════════════════════════════════════════════
   hyrox-db.js — couche base de données partagée par les 3 pages
   ──────────────────────────────────────────────────────────────
   À REMPLIR après avoir créé ton projet Supabase :
   Supabase → Project Settings → API
     • Project URL        → url
     • Project API key "anon public" → cleAnon
   Tant que ces deux champs sont vides, le site tourne en mode
   démonstration : tout fonctionne, mais rien n'est sauvegardé.
   ══════════════════════════════════════════════════════════════ */

const HYROX_CONFIG = {
  url: "https://hunuxzhnjltdxueoxkgz.supabase.co",
  cleAnon: "sb_publishable_TmiLz1s7mLzGzPVdrYHZTw_ND6p93XC"
};

/* Comptes utilisés uniquement en mode démonstration.
   Dès que Supabase est configuré, ce sont les comptes créés
   dans Authentication qui font foi et ceci n'est plus lu. */
const COMPTES_DEMO = {
  "boris@hyrox-essey.fr":  {mdp:"Sled-Boris-54!",         prenom:"Boris",          role:"coach"},
  "nino@hyrox-essey.fr":   {mdp:"Wall-Nino-54!",          prenom:"Nino",           role:"coach"},
  "victor@hyrox-essey.fr": {mdp:"SkiErg-Victor-54!",      prenom:"Victor",         role:"coach"},
  "admin@hyrox-essey.fr":  {mdp:"HYROX-ESSEY-ADMIN-2026", prenom:"Administration", role:"admin"}
};

window.HyroxDB = (function(){
  "use strict";

  const CLE_RESA = "hyrox:reservations", CLE_SEANCES = "hyrox:seances", CLE_REMPLAC = "hyrox:remplacements";
  const configure = !!(HYROX_CONFIG.url && HYROX_CONFIG.cleAnon);

  let client = null, profil = null, initPromise = null;
  const memoire = {[CLE_RESA]: [], [CLE_SEANCES]: [], [CLE_REMPLAC]: {}};
  const snapshot = {};

  /* ── Correspondance JavaScript ↔ colonnes SQL ── */
  const versJsResa = r => ({
    id:r.id, date:r.date, slot:r.slot, debut:r.debut, fin:r.fin, coach:r.coach, montant:r.montant,
    prenom:r.prenom, nom:r.nom, email:r.email, tel:r.tel, naissance:r.naissance, adherent:r.adherent,
    niveau:r.niveau, objectif:r.objectif, image:r.image, signature:r.signature,
    signeLe:r.signe_le, cgvVersion:r.cgv_version, statut:r.statut, payeLe:r.paye_le, presence:r.presence
  });
  const versSqlResa = r => ({
    id:r.id, date:r.date, slot:r.slot, debut:r.debut, fin:r.fin, coach:r.coach, montant:r.montant,
    prenom:r.prenom, nom:r.nom, email:r.email, tel:r.tel, naissance:r.naissance || null, adherent:r.adherent || null,
    niveau:r.niveau, objectif:r.objectif, image:!!r.image, signature:r.signature,
    signe_le:r.signeLe, cgv_version:r.cgvVersion, statut:r.statut, paye_le:r.payeLe, presence:r.presence
  });
  const versJsSeance = s => ({
    id:s.id, date:s.date, slot:s.slot, debut:s.debut, fin:s.fin, coach:s.coach,
    duree:s.duree, inscrits:s.inscrits, presents:s.presents, encaisse:s.encaisse, clotureLe:s.cloture_le
  });
  const versSqlSeance = s => ({
    id:s.id, date:s.date, slot:s.slot, debut:s.debut, fin:s.fin, coach:s.coach,
    duree:s.duree, inscrits:s.inscrits, presents:s.presents, encaisse:s.encaisse, cloture_le:s.clotureLe
  });

  /* ── Démarrage du client Supabase ── */
  async function init(){
    if(!configure) return null;
    if(!initPromise) initPromise = (async ()=>{
      const mod = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
      client = mod.createClient(HYROX_CONFIG.url, HYROX_CONFIG.cleAnon);
      const {data} = await client.auth.getSession();
      if(data && data.session) await chargerProfil(data.session.user.email);
      return client;
    })();
    return initPromise;
  }
  async function chargerProfil(email){
    const {data} = await client.from("coaches").select("prenom, role").eq("email", email).maybeSingle();
    profil = data || {prenom:"Coach", role:"coach"};
    return profil;
  }
  const connecte = () => !!profil;
  const copie = v => JSON.parse(JSON.stringify(v));

  /* ── Comparaison avant / après pour n'écrire que les changements ── */
  function diff(avant, apres){
    const parId = new Map((avant||[]).map(x=>[x.id,x]));
    const ids = new Set(apres.map(x=>x.id));
    return {
      nouveaux: apres.filter(x=>!parId.has(x.id)),
      modifies: apres.filter(x=>parId.has(x.id) && JSON.stringify(parId.get(x.id)) !== JSON.stringify(x)),
      supprimes: (avant||[]).filter(x=>!ids.has(x.id))
    };
  }

  /* ── Lecture ── */
  async function lire(cle, defaut){
    if(!configure){ return cle in memoire ? memoire[cle] : defaut; }
    await init();
    try{
      if(cle === CLE_REMPLAC){
        const {data, error} = await client.from("remplacements").select("date, coach");
        if(error) throw error;
        const o = {}; (data||[]).forEach(r=>o[r.date] = r.coach);
        snapshot[cle] = copie(o);
        return o;
      }
      if(cle === CLE_SEANCES){
        if(!connecte()) return defaut;
        const {data, error} = await client.from("seances").select("*").order("date", {ascending:false});
        if(error) throw error;
        const l = (data||[]).map(versJsSeance);
        snapshot[cle] = copie(l);
        return l;
      }
      if(cle === CLE_RESA){
        if(connecte()){
          const {data, error} = await client.from("reservations").select("*").order("date");
          if(error) throw error;
          const l = (data||[]).map(versJsResa);
          snapshot[cle] = copie(l);
          return l;
        }
        /* Visiteur non connecté : uniquement de quoi compter les places,
           aucune donnée personnelle ne quitte la base. */
        const {data, error} = await client.rpc("places_publiques");
        if(error) throw error;
        const l = data || [];
        snapshot[cle] = copie(l);
        return l;
      }
    }catch(e){ console.warn("Lecture impossible :", e.message || e); return defaut; }
    return defaut;
  }

  /* ── Écriture ── */
  async function ecrire(cle, valeur){
    memoire[cle] = valeur;
    if(!configure) return false;
    await init();
    try{
      if(cle === CLE_REMPLAC){
        const avant = snapshot[cle] || {};
        for(const [date, coach] of Object.entries(valeur))
          if(avant[date] !== coach){
            const {error} = await client.from("remplacements").upsert({date, coach});
            if(error) throw error;
          }
        for(const date of Object.keys(avant))
          if(!(date in valeur)) await client.from("remplacements").delete().eq("date", date);
        snapshot[cle] = copie(valeur);
        return true;
      }

      const d = diff(snapshot[cle], valeur);

      if(cle === CLE_SEANCES){
        if(d.nouveaux.length){
          const {error} = await client.from("seances").insert(d.nouveaux.map(versSqlSeance));
          if(error) throw error;
        }
        for(const s of d.modifies) await client.from("seances").update(versSqlSeance(s)).eq("id", s.id);
        for(const s of d.supprimes) await client.from("seances").delete().eq("id", s.id);
        snapshot[cle] = copie(valeur);
        return true;
      }

      if(cle === CLE_RESA){
        if(connecte()){
          if(d.nouveaux.length){
            const {error} = await client.from("reservations").insert(d.nouveaux.map(versSqlResa));
            if(error) throw error;
          }
          for(const r of d.modifies) await client.from("reservations").update(versSqlResa(r)).eq("id", r.id);
          for(const r of d.supprimes) await client.from("reservations").delete().eq("id", r.id);
        } else {
          /* Visiteur : il peut créer sa réservation et régler la sienne, rien d'autre. */
          for(const r of d.nouveaux){
            const {error} = await client.from("reservations").insert(versSqlResa(r));
            if(error) throw error;
          }
          for(const r of d.modifies)
            if(r.statut === "paye") await client.rpc("marquer_paye", {p_id: r.id});
        }
        snapshot[cle] = copie(valeur);
        return true;
      }
    }catch(e){ console.warn("Écriture impossible :", e.message || e); return false; }
    return false;
  }

  /* ── Réservations d'un participant, retrouvées par son email ── */
  async function mesReservations(email){
    if(!configure)
      return (memoire[CLE_RESA] || []).filter(r=>r.email === email && r.statut !== "annule");
    await init();
    const {data, error} = await client.rpc("mes_reservations", {p_email: email});
    if(error){ console.warn(error.message); return []; }
    return (data || []).map(versJsResa);
  }

  /* ── Connexion des coachs et de l'administrateur ── */
  async function connexion(email, mdp){
    email = (email || "").trim().toLowerCase();
    if(!configure){
      const c = COMPTES_DEMO[email];
      if(!c || c.mdp !== mdp) return {ok:false};
      profil = {prenom:c.prenom, role:c.role};
      return {ok:true, ...profil};
    }
    await init();
    const {error} = await client.auth.signInWithPassword({email, password: mdp});
    if(error) return {ok:false, message:error.message};
    await chargerProfil(email);
    return {ok:true, ...profil};
  }
  async function deconnexion(){ if(client) await client.auth.signOut(); profil = null; }

  return {
    lire, ecrire, mesReservations, connexion, deconnexion,
    get profil(){ return profil; },
    get persistant(){ return configure; },
    get pret(){ return configure; }
  };
})();