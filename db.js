/* ============================================================
   LazySyndic — couche Supabase (auth + accès données)
   Projet partagé avec LazyPO, tables préfixées ls_.
   Expose window.LS = { ready, auth, db, member, canWrite }.
   ============================================================ */
(function(){
  'use strict';
  const cfg = window.LAZYSYNDIC_CONFIG || {};
  // « configuré » = identifiants présents → la connexion est OBLIGATOIRE.
  const configured = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !/VOTRE/.test(cfg.SUPABASE_URL));
  // « hasClient » = configuré ET la lib Supabase a bien chargé.
  const hasClient = !!(configured && window.supabase);
  const sb = hasClient ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;
  window.sb = sb;

  /* ---------- dates ISO <-> affichage DD/MM/YY ---------- */
  const pad = n => String(n).padStart(2,'0');
  function isoToDisp(iso){
    const m = String(iso||'').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : String(iso||'');
  }
  function dispToIso(disp){
    let m = String(disp||'').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (!m) return null;
    let y = +m[3]; if (y < 100) y += 2000;
    return `${y}-${pad(+m[2])}-${pad(+m[1])}`;
  }

  /* ---------- AUTH ---------- */
  const auth = {
    async session(){ if(!sb) return null; const {data}=await sb.auth.getSession(); return data.session; },
    async signInPassword(email, password){
      const {data, error} = await sb.auth.signInWithPassword({email, password});
      if (error) throw error; return data;
    },
    async signInMagic(email){
      const {error} = await sb.auth.signInWithOtp({
        email, options:{ emailRedirectTo: location.href.split('#')[0] }
      });
      if (error) throw error;
    },
    async signOut(){ if(sb) await sb.auth.signOut(); },
    onChange(cb){ if(sb) sb.auth.onAuthStateChange((_e,s)=>cb(s)); },
  };

  // Profil membre LazySyndic (role + owner). On réutilise l'utilisateur de la
  // session (passé en argument) pour éviter un appel réseau getUser() redondant ;
  // repli sur getUser() seulement si non fourni.
  async function loadMember(user){
    if(!sb) return null;
    if(!user){ const {data:{user:u}} = await sb.auth.getUser(); user=u; }
    if(!user) return null;
    const {data, error} = await sb.from('ls_members').select('role,owner_short,full_name,email').eq('id', user.id).maybeSingle();
    if (error){ console.warn('ls_members', error.message); return null; }
    return data ? {...data, id:user.id, userEmail:user.email} : null;
  }

  /** Ligne SQL → transaction telle que l'app la manipule. Une seule définition : les trois listes
   *  (grand livre, brouillons, corbeille) doivent avoir exactement la même forme. */
  const mapTx = r => ({
    id:r.id, date:isoToDisp(r.tx_date), tiers:r.tiers, high:r.high, sub:r.sub||'',
    amount:Number(r.amount), account:r.account, note:r.note||'', flag:!!r.flag,
    comment:r.comment||'', owner:r.owner||'', importV:r.import_v ?? null,
    // ligne arrivée par la synchro bancaire (Enable Banking) : la référence de la banque
    bankRef:r.bank_ref||''
  });

  /* ---------- CHARGEMENT (read) ---------- */
  async function loadAll(){
    const tables = ['ls_owners','ls_lots','ls_settings','ls_transactions','ls_rules','ls_aliases','ls_contracts','ls_reminders','ls_imports','ls_ag','ls_ag_points','ls_timeline','ls_periods','ls_budgets'];
    const res = {};
    await Promise.all(tables.map(async t=>{
      const {data, error} = await sb.from(t).select('*');
      if (error){
        // tables AG optionnelles : tolérer leur absence (schéma pas encore migré)
        if (t==='ls_ag' || t==='ls_ag_points' || t==='ls_timeline' || t==='ls_periods'){ res[t]=[]; return; }
        // ls_budgets (supabase/budgets.sql) absente : null, pour retomber sur l'ancien jsonb ls_settings.charges
        if (t==='ls_budgets'){ res[t]=null; return; }
        throw new Error(`${t}: ${error.message}`);
      }
      res[t] = data || [];
    }));
    const settings = res.ls_settings[0] || {};
    const ownersRows = res.ls_owners.sort((a,b)=>(a.sort||0)-(b.sort||0));
    return {
      // Le grand livre ne contient que le validé. Un brouillon vit dans sa propre liste : c'est ce
      // qui permet à tous les calculs (soldes, réconciliation, appels de fonds) de continuer à lire
      // `state.tx` sans jamais avoir à se demander si une ligne compte ou pas.
      tx: res.ls_transactions.filter(r=>!r.deleted_at && !r.draft).map(mapTx),
      draftTx: res.ls_transactions.filter(r=>!r.deleted_at && r.draft).map(mapTx),
      trash: res.ls_transactions.filter(r=>r.deleted_at && r.deleted_at>=new Date(Date.now()-7*86400000).toISOString())
        .sort((a,b)=>(b.deleted_at||'').localeCompare(a.deleted_at||''))
        .map(r=>({ ...mapTx(r), deleted_at:r.deleted_at })),
      rules:   res.ls_rules.sort((a,b)=>(a.sort||0)-(b.sort||0)).map(r=>[r.label, r.high, r.sub||'', r.id]),
      aliases: res.ls_aliases.sort((a,b)=>(a.sort||0)-(b.sort||0)).map(r=>[r.label, r.entity, !!r.is_owner, r.short||'', r.id]),
      contracts: res.ls_contracts.sort((a,b)=>(a.sort||0)-(b.sort||0)).map(r=>({
        id:r.id, name:r.name, ref:r.ref, type:r.type, start:r.start, note:r.note,
        status:r.status, end:r.end_date, endNote:r.end_note, fournisseur:r.fournisseur||''
      })),
      reminders: res.ls_reminders.sort((a,b)=>(a.sort||0)-(b.sort||0)).map(r=>({id:r.id, tx:r.tx, due:r.due, done:!!r.done})),
      imports: res.ls_imports.sort((a,b)=>(b.v||0)-(a.v||0)).map(r=>({id:r.id, v:r.v, label:r.label, meta:r.meta, cur:!!r.cur, pending:!!r.pending, stmt:r.stmt||null})),
      timeline: (res.ls_timeline||[]).map(r=>({id:r.id, date:r.event_date, title:r.title, description:r.description||'', kind:r.kind||'manual', subs:Array.isArray(r.subs)?r.subs:[]})),
      opening: { pay:Number(settings.opening_pay||0), res:Number(settings.opening_res||0) },
      contrib: settings.contrib || {},
      ledgerLive: !!settings.ledger_live,
      reserveTarget: Number(settings.reserve_target||2000),
      ibanMap: settings.iban_map || {},
      coproName: settings.copro_name || '',
      coproAddr: settings.copro_addr || '',
      coproKbo:  settings.copro_kbo  || '',
      budgetKeys: settings.budget_keys || {},
      ibans: { pay: settings.iban_pay||'', res: settings.iban_res||'' },
      holders: settings.holders || {},   // titulaire par compte (supabase/releve.sql) — relevé de compte PDF
      // Budgets prévisionnels (supabase/budgets.sql) : une ligne par exercice, un copropriétaire ne
      // reçoit que les publiés (RLS). Même forme qu'avant pour l'app : { "2026": {postes, reserve, …} }.
      // Sans la table (SQL pas encore passé), l'ancien jsonb ls_settings.charges (supabase/charges.sql).
      charges: res.ls_budgets ? Object.fromEntries(res.ls_budgets.map(r=>[String(r.year), {
        postes:Array.isArray(r.postes)?r.postes:[], reserve:Array.isArray(r.reserve)?r.reserve:[],
        marge:r.marge==null?3:Number(r.marge), status:r.status||'draft', applied:r.applied||null,
        approved:r.approved||null, snapshot:r.snapshot||null, publishedAt:r.published_at||null, updatedAt:r.updated_at||null
      }])) : (settings.charges || {}),
      budgetsStore: res.ls_budgets ? 'table' : 'settings',
      recon: settings.recon || {},   // {pay:{closing,asOf}, res:{...}}
      annualNote: settings.annual_note || '',
      categories: settings.categories || [],
      subcats: settings.subcats || {},
      ownerRules: settings.owner_rules || {},
      owners: ownersRows.map(r=>({id:r.id, n:r.name, short:r.short, q:r.quotite, c:r.color||'#2F6B53',
        due_pay:Number(r.due_pay||0), due_res:Number(r.due_res||0), email:r.email||'',
        ogm:r.ogm||'', periodicity:r.periodicity||'month'})),   // appels de fonds (supabase/calls.sql)
      lots: res.ls_lots.map(r=>({id:r.id, label:r.label, designation:r.designation, quotite:r.quotite, parcelle:r.parcelle, owner_id:r.owner_id})),
      // Exercices comptables (supabase/periods.sql) : clôturé = closed_at posé, lignes verrouillées par la base.
      periods: (res.ls_periods||[]).sort((a,b)=>(a.year||0)-(b.year||0)).map(r=>({
        year:r.year, starts:r.starts, ends:r.ends, closed_at:r.closed_at||null, closed_by:r.closed_by||null,
        opening_pay:r.opening_pay==null?null:Number(r.opening_pay), opening_res:r.opening_res==null?null:Number(r.opening_res),
        closing_pay:r.closing_pay==null?null:Number(r.closing_pay), closing_res:r.closing_res==null?null:Number(r.closing_res),
        approved_ag_id:r.approved_ag_id||null, report_html:r.report_html||'', note:r.note||''
      })),
      ags: (res.ls_ag||[]).sort((a,b)=>(b.created_at||'').localeCompare(a.created_at||'')).map(a=>({
        id:a.id, title:a.title, ag_date:a.ag_date, lieu:a.lieu, type:a.type||'Ordinaire',
        convocation_date:a.convocation_date, status:a.status||'prep', presence:a.presence||{},
        bureau:a.bureau||{}, signature:a.signature||{},
        points: (res.ls_ag_points||[]).filter(p=>p.ag_id===a.id).sort((x,y)=>(x.pos||0)-(y.pos||0)).map(p=>({
          id:p.id, ag_id:p.ag_id, pos:p.pos||0, title:p.title||'', body:p.body||'',
          kind:p.kind||'decision', majorite:p.majorite||'simple', cle:p.cle||'Acte de base',
          votes:p.votes||{}, seance_notes:p.seance_notes||'', decision:p.decision||''
        }))
      })),
    };
  }

  /* ---------- ÉCRITURES (write — admin) ---------- */
  const T = name => sb.from(name);
  const db = {
    loadAll, loadMember, isoToDisp, dispToIso,

    /** `opts.draft` marque l'insertion comme brouillon, `opts.importV` la rattache à son relevé. */
    async addTransactions(rows, opts={}){
      const payload = rows.map(t=>({
        tx_date:dispToIso(t.date), tiers:t.tiers, high:t.high, sub:t.sub||'',
        amount:t.amount, account:t.account, note:t.note||'', flag:!!t.flag, comment:t.comment||'', owner:t.owner||'',
        draft: !!opts.draft, import_v: opts.importV ?? null
      }));
      const {data, error} = await T('ls_transactions').insert(payload).select();
      if (error) throw error;
      return data.map(mapTx);
    },

    /** Le relevé rejoint le grand livre. Les lignes gardent leur id : rien n'est recréé. */
    async confirmImport(importV){
      const {error} = await T('ls_transactions').update({draft:false}).eq('import_v', importV).eq('draft', true);
      if (error) throw error;
    },

    /** Jeter un relevé mal importé — ne touche que ses brouillons, jamais le grand livre. */
    async discardDraftImport(importV){
      const {error} = await T('ls_transactions').delete().eq('import_v', importV).eq('draft', true);
      if (error) throw error;
    },
    async updateTransaction(id, patch){
      const {error} = await T('ls_transactions').update(patch).eq('id', id); if (error) throw error;
    },
    async deleteTransaction(id){ const {error}=await T('ls_transactions').delete().eq('id',id); if(error)throw error; },
    async deleteTransactions(ids){ if(!ids||!ids.length)return; const {error}=await T('ls_transactions').delete().in('id',ids); if(error)throw error; },
    async softDeleteTransactions(ids){ if(!ids||!ids.length)return; const {error}=await T('ls_transactions').update({deleted_at:new Date().toISOString()}).in('id',ids); if(error)throw error; },
    async restoreTransactions(ids){ if(!ids||!ids.length)return; const {error}=await T('ls_transactions').update({deleted_at:null}).in('id',ids); if(error)throw error; },
    async purgeOldTrash(){ const cut=new Date(Date.now()-7*86400000).toISOString(); const {error}=await T('ls_transactions').delete().not('deleted_at','is',null).lt('deleted_at',cut); if(error)throw error; },

    /** Le plus grand numéro de relevé en base : le pont de synchro bancaire en crée aussi, pendant
     *  que l'app est ouverte ; deux relevés qui partagent un numéro se valideraient ensemble. */
    async maxImportV(){
      const [a, b] = await Promise.all([
        T('ls_imports').select('v').not('v','is',null).order('v',{ascending:false}).limit(1),
        T('ls_transactions').select('import_v').not('import_v','is',null).order('import_v',{ascending:false}).limit(1),
      ]);
      if (a.error) throw a.error;
      if (b.error) throw b.error;
      return Math.max(Number(a.data?.[0]?.v)||0, Number(b.data?.[0]?.import_v)||0);
    },

    /* ---------- Synchro bancaire (Enable Banking — baseline §12, bridge/banksync.js) ----------
       ls_bank_links est la boîte aux lettres entre l'app et le pont : réservée au syndic (RLS),
       un copropriétaire en lecture seule reçoit une liste vide. Le code de la banque n'est jamais
       relu ici. */
    async bankLinks(){
      const {data, error} = await T('ls_bank_links')
        .select('id,status,aspsp_name,aspsp_country,psu_type,state,auth_url,valid_until,accounts,acct_map,sync_requested_at,last_sync_at,last_ok_at,last_sync,error,created_at,updated_at')
        .order('created_at', {ascending:false}).limit(10);
      if (error) throw error;
      return data || [];
    },
    /** Historique des synchros (ls_bank_syncs), écrit par le pont seul ; le plus récent d'abord. */
    async bankSyncs(limit=50){
      const {data, error} = await T('ls_bank_syncs')
        .select('id,link_id,at,cause,ok,added_pay,added_res,known,matched,balances,warnings,error')
        .order('at', {ascending:false}).limit(limit);
      if (error) throw error;
      return data || [];
    },
    async bankLinkAdd(row){ const {data,error}=await T('ls_bank_links').insert(row).select('id').single(); if(error)throw error; return data; },
    async bankLinkUpdate(id, patch){ const {error}=await T('ls_bank_links').update(patch).eq('id',id); if(error)throw error; },

    async addImport(row){
      const {data, error} = await T('ls_imports').insert(row).select().single(); if (error) throw error; return data;
    },
    async clearCurrentImport(){
      const {error} = await T('ls_imports').update({cur:false}).eq('cur', true); if (error) throw error;
    },
    async updateImport(id, patch){
      const {error} = await T('ls_imports').update(patch).eq('id', id); if (error) throw error;
    },
    async deleteImport(id){
      const {error} = await T('ls_imports').delete().eq('id', id); if (error) throw error;
    },

    async updateReminder(id, patch){ const {error}=await T('ls_reminders').update(patch).eq('id',id); if(error)throw error; },
    async addReminder(row){ const {data,error}=await T('ls_reminders').insert(row).select().single(); if(error)throw error; return data; },

    async addContract(row){
      const {data,error}=await T('ls_contracts').insert({
        name:row.name, ref:row.ref, type:row.type, start:row.start, note:row.note, status:row.status||'actif', fournisseur:row.fournisseur||''
      }).select().single(); if(error)throw error; return data;
    },
    async updateContract(id, patch){
      const p={}; if('status'in patch)p.status=patch.status; if('end'in patch)p.end_date=patch.end; if('endNote'in patch)p.end_note=patch.endNote;
      if('fournisseur'in patch)p.fournisseur=patch.fournisseur; if('note'in patch)p.note=patch.note;
      const {error}=await T('ls_contracts').update(p).eq('id',id); if(error)throw error;
    },

    async addRule(row){ const {data,error}=await T('ls_rules').insert(row).select().single(); if(error)throw error; return data; },
    async updateRule(id, patch){ const {error}=await T('ls_rules').update(patch).eq('id',id); if(error)throw error; },
    async deleteRule(id){ const {error}=await T('ls_rules').delete().eq('id',id); if(error)throw error; },

    async addAlias(row){ const {data,error}=await T('ls_aliases').insert(row).select().single(); if(error)throw error; return data; },
    async updateAlias(id, patch){ const {error}=await T('ls_aliases').update(patch).eq('id',id); if(error)throw error; },
    async deleteAlias(id){ const {error}=await T('ls_aliases').delete().eq('id',id); if(error)throw error; },

    async updateSettings(patch){ const {error}=await T('ls_settings').update(patch).eq('id',1); if(error)throw error; },
    async updateOwner(id, patch){ const {error}=await T('ls_owners').update(patch).eq('id',id); if(error)throw error; },

    async addTimeline(row){ const {data,error}=await T('ls_timeline').insert(row).select().single(); if(error)throw error; return data; },
    async updateTimeline(id, patch){ const {error}=await T('ls_timeline').update(patch).eq('id',id); if(error)throw error; },
    async deleteTimeline(id){ const {error}=await T('ls_timeline').delete().eq('id',id); if(error)throw error; },

    // Sauvegarde : dump brut de toutes les tables (forme DB, round-trip fidèle).
    async dumpAll(){
      const tables=['ls_owners','ls_lots','ls_transactions','ls_rules','ls_aliases','ls_contracts','ls_reminders','ls_settings','ls_imports','ls_ag','ls_ag_points','ls_periods','ls_budgets'];
      const out={};
      for(const t of tables){ const {data,error}=await sb.from(t).select('*'); if(error) throw new Error(t+': '+error.message); out[t]=data||[]; }
      return out;
    },
    // Restauration : remplace TOUTES les données par celles de la sauvegarde.
    async restore(backup){
      const delOrder=['ls_budgets','ls_periods','ls_ag_points','ls_ag','ls_lots','ls_transactions','ls_rules','ls_aliases','ls_contracts','ls_reminders','ls_imports','ls_owners'];
      // ls_periods et ls_budgets ont l'exercice pour clé, pas un id
      for(const t of delOrder){ const pk=(t==='ls_periods'||t==='ls_budgets')?'year':'id'; const {error}=await sb.from(t).delete().not(pk,'is',null); if(error) throw new Error('delete '+t+': '+error.message); }
      const insOrder=['ls_owners','ls_lots','ls_transactions','ls_rules','ls_aliases','ls_contracts','ls_reminders','ls_imports','ls_ag','ls_ag_points','ls_periods','ls_budgets'];
      for(const t of insOrder){ const rows=(backup[t]||[]); if(rows.length){ const {error}=await sb.from(t).insert(rows); if(error) throw new Error('insert '+t+': '+error.message); } }
      if(backup.ls_settings && backup.ls_settings[0]){ const {id, ...rest}=backup.ls_settings[0]; const {error}=await sb.from('ls_settings').update(rest).eq('id',1); if(error) throw new Error('settings: '+error.message); }
    },

    // --- Assemblées générales ---
    async agCreate(row){ const {data,error}=await T('ls_ag').insert(row).select().single(); if(error)throw error; return data; },
    async agUpdate(id, patch){ const {error}=await T('ls_ag').update(patch).eq('id',id); if(error)throw error; },
    async agDelete(id){ const {error}=await T('ls_ag').delete().eq('id',id); if(error)throw error; },
    async agPointAdd(row){ const {data,error}=await T('ls_ag_points').insert(row).select().single(); if(error)throw error; return data; },
    async agPointUpdate(id, patch){ const {error}=await T('ls_ag_points').update(patch).eq('id',id); if(error)throw error; },
    async agPointDelete(id){ const {error}=await T('ls_ag_points').delete().eq('id',id); if(error)throw error; },

    // --- Exercices comptables (supabase/periods.sql) ---
    async periodUpsert(row){ const {data,error}=await T('ls_periods').upsert(row).select().single(); if(error)throw error; return data; },
    async periodUpdate(year, patch){ const {error}=await T('ls_periods').update(patch).eq('year',year); if(error)throw error; },

    // --- Budgets prévisionnels (supabase/budgets.sql) : une ligne par exercice. Un budget publié
    //     est figé par la base (trigger ls_budgets_guard) : l'app n'envoie que ce qui peut changer.
    async budgetUpsert(row){ const {data,error}=await T('ls_budgets').upsert(row).select().single(); if(error)throw error; return data; },

    // --- PV d'AG : bucket privé ls-docs (supabase/ag.sql) ---
    async docUpload(path, bytes){
      const {error}=await sb.storage.from('ls-docs').upload(path, new Blob([bytes],{type:'application/pdf'}), {upsert:true, contentType:'application/pdf'});
      if(error) throw error;
    },
    async docDownload(path){
      const {data,error}=await sb.storage.from('ls-docs').download(path);
      if(error) throw error;
      return new Uint8Array(await data.arrayBuffer());
    },
  };

  window.LS = { configured, hasClient, sb, auth, db, member:null, canWrite:false };
})();
