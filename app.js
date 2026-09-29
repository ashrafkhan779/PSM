/* Shared procurement book. All authority is checked by PostgreSQL, not UI flags. */
(() => {
  'use strict';
  const el=id=>document.getElementById(id);
  let client, role=null, revision=null, saved=null, draft=null, busy=false, userId=null, epoch=0;
  const message=s=>{el('authMessage').textContent=s;};
  function validate(ds){
    if(!ds || typeof ds.meta!=='object' || Array.isArray(ds.meta) || !ds.meta || !Array.isArray(ds.records) || !ds.records.length)throw new Error('Expected meta and a non-empty records array.');
    if(ds.records.length>20000)throw new Error('This MVP supports up to 20,000 lines per book.');
    for(const [i,r] of ds.records.entries()){
      if(!r||typeof r!=='object'||Array.isArray(r)||typeof r.po!=='string'||!r.po.trim())throw new Error(`Row ${i+1}: PO is required.`);
      for(const k of ['orderQty','delivQty','pendQty','value','pendValue'])if(typeof r[k]!=='number'||!Number.isFinite(r[k])||r[k]<0)throw new Error(`Row ${i+1}: invalid ${k}.`);
      // Legacy dashboard uses HTML templates and inline handlers. Reject executable
      // markup / handler delimiters instead of accepting untrusted HTML in imports.
      for(const [k,v] of Object.entries(r))if(typeof v==='string'&&(/[<>]/.test(v)||(k!=='desc'&&/["\\\r\n]/.test(v))||(/^(po|material)$/.test(k)&&/'/.test(v))||/&#(?:x[0-9a-f]+|[0-9]+);?|&(?:quot|apos|lt|gt);/i.test(v)))throw new Error(`Row ${i+1}: unsupported markup or quote in ${k}.`);
    }
    for(const v of Object.values(ds.meta))if(typeof v==='string'&&/[<>]/.test(v))throw new Error('Metadata must be plain text.');
    return structuredClone(ds);
  }
  function applyAccess(){
    const admin=role==='admin';
    document.querySelectorAll('[data-admin-only]').forEach(e=>{e.hidden=!admin;});
    if(!admin&&view==='data')view='overview';
  }
  function status(){el('cloudStatus').textContent=`${role||'No access'} · v${revision??'—'} · ${draft?'UNSAVED PREVIEW':'Saved database'}`;}
  function lock(text){
    epoch++; role=null; revision=null; saved=null; draft=null; userId=null;
    applyAccess();R=[];ALLR=[];M={};K={};exportJSON=null;lastUpload=null;
    if(typeof aiMsgs!=='undefined')aiMsgs=[];
    if(typeof aihMsgs!=='undefined')aihMsgs=[];
    el('view').replaceChildren();el('foot').replaceChildren();
    document.body.classList.add('locked');el('authGate').hidden=false;el('cloudBar').hidden=true;message(text);
  }
  function display(ds){applyAccess();setDataset(structuredClone(ds));status();}
  async function load(){
    const ticket=epoch;
    const {data,error}=await client.rpc('psm_get_book');
    if(ticket!==epoch)return;
    if(error)throw error;
    if(!data)throw new Error('No database response. Run 01_schema.sql first.');
    const next=data.records.length?validate({meta:data.meta,records:data.records}):{meta:data.meta||{},records:[]};
    role=data.role;revision=data.revision;saved=next;draft=null;lastUpload=null;
    display(saved);document.body.classList.remove('locked');el('authGate').hidden=true;el('cloudBar').hidden=false;
    if(!saved.records.length){if(role==='admin'){go('data');toast('Database is empty. Import initial-data.json, then save.');}else toast('The database is empty. Please ask an administrator to import data.');}
  }
  async function enter(session){
    if(!session){lock('Enter your email and password.');el('gateSignOut').hidden=true;return;}
    userId=session.user.id;el('gateSignOut').hidden=false;message('Loading your database…');
    try{await load();}catch(e){lock('Could not load the database: '+e.message+'\nCheck setup and your membership, then sign in again.');el('gateSignOut').hidden=false;}
  }
  window.PSM={
    isAdmin:()=>role==='admin',
    canEdit:()=>role==='admin'&&!busy,
    pending:()=>!!draft,
    dataset:()=>structuredClone(draft||saved||{meta:{},records:[]}),
    preview(ds,name){
      if(!this.canEdit())throw new Error('Admin access is required.');
      draft=validate(ds);lastUpload=name;display(draft);view='data';renderData();toast(`Preview: ${draft.records.length} lines. Review, then Save to Supabase.`);
    },
    async save(){
      if(!this.canEdit()||!draft)return;
      if(!confirm(`Replace the shared purchase book with these ${draft.records.length} lines? The previous version will be kept in database history.`))return;
      busy=true;const ticket=epoch;const payload=structuredClone(draft);renderData();
      try{
        const {data,error}=await client.rpc('psm_save_book',{p_dataset:payload,p_expected_revision:revision});
        if(ticket!==epoch)return;
        if(error)throw error;
        revision=data.revision;saved=payload;draft=null;display(saved);toast('Saved to Supabase. Other users can refresh to see this version.');
      }catch(e){toast('Save failed; preview retained. '+e.message,true);}
      finally{busy=false;if(ticket===epoch){status();if(view==='data')renderData();}}
    },
    async reload(){
      if(busy)return;
      if(draft&&!confirm('Discard the unsaved preview and load the saved database?'))return;
      busy=true;
      try{await load();toast('Loaded the latest saved version.');}catch(e){toast('Refresh failed: '+e.message,true);}
      finally{busy=false;if(view==='data'&&role)renderData();}
    },
    async signOut(){
      if(busy){toast('Please wait for the current operation.');return;}
      if(draft&&!confirm('Sign out and discard the unsaved preview?'))return;
      lock('Signing out…');
      try{const {error}=await client.auth.signOut({scope:'local'});if(error)throw error;location.reload();}
      catch(e){message('Sign-out failed: '+e.message+'. Use Sign out / switch account to retry.');el('gateSignOut').hidden=false;}
    }
  };
  window.addEventListener('beforeunload',e=>{if(draft){e.preventDefault();e.returnValue='';}});
  el('gateSignOut').onclick=()=>window.PSM.signOut();
  el('loginForm').onsubmit=async e=>{
    e.preventDefault();if(!client)return;
    el('loginButton').disabled=true;message('Signing in…');
    try{
      const {data,error}=await client.auth.signInWithPassword({email:el('loginEmail').value.trim(),password:el('loginPassword').value});
      if(error)throw error;
      el('loginPassword').value='';await enter(data.session);
    }catch(err){message(err.message);}finally{el('loginButton').disabled=false;}
  };
  async function boot(){
    const c=window.PSM_CONFIG;
    if(!c||!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(c.supabaseUrl)||!c.supabaseKey||c.supabaseKey.includes('YOUR_')){
      message('Setup required: edit site/config.js with your Supabase project URL and publishable key. Follow START-HERE.md.');el('loginButton').disabled=true;return;
    }
    if(c.supabaseKey.startsWith('sb_secret_')){message('Wrong key: use a publishable key, never a secret key.');return;}
    if(c.supabaseKey.split('.').length===3){
      try{const claims=JSON.parse(atob(c.supabaseKey.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));if(claims.role!=='anon'){message('Wrong legacy key: only the anon key may be used in the browser.');return;}}
      catch{message('Invalid legacy API key. Copy the publishable key from Supabase.');return;}
    }
    if(!window.supabase){message('Supabase library did not load. Check your internet connection and reload.');return;}
    client=window.supabase.createClient(c.supabaseUrl,c.supabaseKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,storageKey:'psm-'+new URL(c.supabaseUrl).hostname}});
    client.auth.onAuthStateChange((event,session)=>{
      if(event==='SIGNED_OUT'){lock('You have signed out.');el('gateSignOut').hidden=true;}
      else if(event==='SIGNED_IN'&&userId&&userId!==session?.user.id){lock('Account changed. Reloading…');location.reload();}
    });
    try{const {data,error}=await client.auth.getSession();if(error)throw error;await enter(data.session);}catch(e){message('Connection failed: '+e.message);}
  }
  boot();
})();
