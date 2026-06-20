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

  // Profil membre LazySyndic (role + owner) pour l'utilisateur courant
  async function loadMember(){
    if(!sb) return null;
    const {data:{user}} = await sb.auth.getUser();
    if(!user) return null;
    const {data, error} = await sb.from('ls_members').select('role,owner_short,full_name,email').eq('id', user.id).maybeSingle();
    if (error){ console.warn('ls_members', error.message); return null; }
    return data ? {...data, id:user.id, userEmail:user.email} : null;
  }

  /* ---------- CHARGEMENT (read) ---------- */
  async function loadAll(){
    const tables = ['ls_owners','ls_lots','ls_settings','ls_transactions','ls_rules','ls_aliases','ls_contracts','ls_reminders','ls_imports'];
    const res = {};
    await Promise.all(tables.map(async t=>{
      const {data, error} = await sb.from(t).select('*');
      if (error) throw new Error(`${t}: ${error.message}`);
      res[t] = data || [];
    }));
    const settings = res.ls_settings[0] || {};
    const ownersRows = res.ls_owners.sort((a,b)=>(a.sort||0)-(b.sort||0));
    return {
      tx: res.ls_transactions.map(r=>({
        id:r.id, date:isoToDisp(r.tx_date), tiers:r.tiers, high:r.high, sub:r.sub||'',
        amount:Number(r.amount), account:r.account, note:r.note||'', flag:!!r.flag, comment:r.comment||''
      })),
      rules:   res.ls_rules.sort((a,b)=>(a.sort||0)-(b.sort||0)).map(r=>[r.label, r.high, r.sub||'', r.id]),
      aliases: res.ls_aliases.sort((a,b)=>(a.sort||0)-(b.sort||0)).map(r=>[r.label, r.entity, !!r.is_owner, r.short||'', r.id]),
      contracts: res.ls_contracts.sort((a,b)=>(a.sort||0)-(b.sort||0)).map(r=>({
        id:r.id, name:r.name, ref:r.ref, type:r.type, start:r.start, note:r.note,
        status:r.status, end:r.end_date, endNote:r.end_note
      })),
      reminders: res.ls_reminders.sort((a,b)=>(a.sort||0)-(b.sort||0)).map(r=>({id:r.id, tx:r.tx, due:r.due, done:!!r.done})),
      imports: res.ls_imports.sort((a,b)=>(b.v||0)-(a.v||0)).map(r=>({id:r.id, v:r.v, label:r.label, meta:r.meta, cur:!!r.cur})),
      opening: { pay:Number(settings.opening_pay||0), res:Number(settings.opening_res||0) },
      contrib: settings.contrib || {},
      ledgerLive: !!settings.ledger_live,
      reserveTarget: Number(settings.reserve_target||2000),
      ibanMap: settings.iban_map || {},
      coproName: settings.copro_name || '',
      budgetKeys: settings.budget_keys || {},
      owners: ownersRows.map(r=>({id:r.id, n:r.name, short:r.short, q:r.quotite, c:r.color||'#2F6B53'})),
      lots: res.ls_lots.map(r=>({id:r.id, label:r.label, designation:r.designation, quotite:r.quotite, parcelle:r.parcelle, owner_id:r.owner_id})),
    };
  }

  /* ---------- ÉCRITURES (write — admin) ---------- */
  const T = name => sb.from(name);
  const db = {
    loadAll, loadMember, isoToDisp, dispToIso,

    async addTransactions(rows){
      const payload = rows.map(t=>({
        tx_date:dispToIso(t.date), tiers:t.tiers, high:t.high, sub:t.sub||'',
        amount:t.amount, account:t.account, note:t.note||'', flag:!!t.flag, comment:t.comment||''
      }));
      const {data, error} = await T('ls_transactions').insert(payload).select();
      if (error) throw error;
      return data.map(r=>({id:r.id, date:isoToDisp(r.tx_date), tiers:r.tiers, high:r.high, sub:r.sub||'',
        amount:Number(r.amount), account:r.account, note:r.note||'', flag:!!r.flag, comment:r.comment||''}));
    },
    async updateTransaction(id, patch){
      const {error} = await T('ls_transactions').update(patch).eq('id', id); if (error) throw error;
    },

    async addImport(row){
      const {data, error} = await T('ls_imports').insert(row).select().single(); if (error) throw error; return data;
    },
    async clearCurrentImport(){
      const {error} = await T('ls_imports').update({cur:false}).eq('cur', true); if (error) throw error;
    },

    async updateReminder(id, patch){ const {error}=await T('ls_reminders').update(patch).eq('id',id); if(error)throw error; },
    async addReminder(row){ const {data,error}=await T('ls_reminders').insert(row).select().single(); if(error)throw error; return data; },

    async addContract(row){
      const {data,error}=await T('ls_contracts').insert({
        name:row.name, ref:row.ref, type:row.type, start:row.start, note:row.note, status:row.status||'actif'
      }).select().single(); if(error)throw error; return data;
    },
    async updateContract(id, patch){
      const p={}; if('status'in patch)p.status=patch.status; if('end'in patch)p.end_date=patch.end; if('endNote'in patch)p.end_note=patch.endNote;
      const {error}=await T('ls_contracts').update(p).eq('id',id); if(error)throw error;
    },

    async addRule(row){ const {data,error}=await T('ls_rules').insert(row).select().single(); if(error)throw error; return data; },
    async updateRule(id, patch){ const {error}=await T('ls_rules').update(patch).eq('id',id); if(error)throw error; },
    async deleteRule(id){ const {error}=await T('ls_rules').delete().eq('id',id); if(error)throw error; },

    async addAlias(row){ const {data,error}=await T('ls_aliases').insert(row).select().single(); if(error)throw error; return data; },
    async updateAlias(id, patch){ const {error}=await T('ls_aliases').update(patch).eq('id',id); if(error)throw error; },
    async deleteAlias(id){ const {error}=await T('ls_aliases').delete().eq('id',id); if(error)throw error; },

    async updateSettings(patch){ const {error}=await T('ls_settings').update(patch).eq('id',1); if(error)throw error; },
  };

  window.LS = { configured, hasClient, sb, auth, db, member:null, canWrite:false };
})();
