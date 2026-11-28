// Mila.Desk. Copyright (c) 2026 Jhoun Milanes (Milanes Production). All rights reserved. See LICENSE.txt. MD-ORIGIN-7F3A91C2
/* Mila.Desk core — pure, dependency-free helpers shared by the service worker,
 * the content script and the popup. Everything here is deterministic and has no
 * access to chrome.*, the DOM or the network, so it can be tested with jsc.
 * Loaded via importScripts (background), the manifest content_scripts list
 * (content.js) and a <script> tag (popup.html).
 */
(function(root){
  "use strict";
  // Visible text goes through MilaI18n when the page loaded it (popup and Amazon pages);
  // elsewhere (service worker, tests) it stays in Spanish.
  const tr=(text,vars)=>{
    if(root.MilaI18n) return root.MilaI18n.t(text,vars);
    return vars?String(text).replace(/\{(\w+)\}/g,(m,k)=>Object.prototype.hasOwnProperty.call(vars,k)?String(vars[k]):m):text;
  };

  const ENTITY_RE=/(\d+#ENTITY[A-Z0-9_-]+)/i;

  // Lenient base64 decoder: accepts URL-safe alphabets and missing padding.
  // Returns a binary string, or "" when the value is not base64.
  function decodeBase64Loose(value){
    let s=String(value||"").trim();
    if(s.startsWith("ctx:")) s=s.slice(4);
    s=s.replace(/-/g,"+").replace(/_/g,"/");
    if(!s || !/^[A-Za-z0-9+/]+=*$/.test(s) || s.replace(/=+$/,"").length%4===1) return "";
    s=s.replace(/=+$/,"");
    s+="=".repeat((4-s.length%4)%4);
    try{ return atob(s); }catch{ return ""; }
  }

  // Extract an Amazon channel entity id ("123#ENTITY…") from a raw value or from
  // a base64 context token. Replaces the double-escaped regexes of 25.2.7.
  function extractEntityId(value){
    const raw=String(value||"");
    const direct=raw.match(ENTITY_RE);
    if(direct) return direct[1];
    const decoded=decodeBase64Loose(raw);
    const match=decoded && decoded.match(ENTITY_RE);
    return match?match[1]:"";
  }

  // The key persisted as creator_conversations.amazon_channel_key.
  // Every existing row uses "ctx:<contextValidatorToken>", so this keeps that exact
  // format. A DOM-derived key (assigned by brand name) is never used as identity:
  // it caused collisions and mixed key formats between runs.
  function conversationStorageKey(channel){
    const token=String(channel?.contextValidatorToken||"").trim();
    return token?"ctx:"+token:"";
  }

  // Read-only diagnostics about a context token. Never returns the token itself.
  function analyzeContextToken(token, actorName=""){
    const decoded=decodeBase64Loose(token);
    const name=String(actorName||"").trim();
    return {
      decodable:!!decoded,
      entityId:extractEntityId(token),
      containsActorName:!!(decoded && name && decoded.includes(name))
    };
  }

  function summarizeKeyDiagnostics(channels, actorName=""){
    const entities=new Map();
    const out={tokens:0,decodable:0,withEntity:0,distinctEntities:0,entitiesWithSeveralTokens:0,containsActorName:0,missingActorName:0,actorName:String(actorName||"")};
    for(const channel of channels||[]){
      const token=String(channel?.contextValidatorToken||"").trim();
      if(!token) continue;
      out.tokens++;
      const info=analyzeContextToken(token,actorName);
      if(info.decodable) out.decodable++;
      if(info.containsActorName) out.containsActorName++; else if(info.decodable) out.missingActorName++;
      if(info.entityId){ out.withEntity++; entities.set(info.entityId,(entities.get(info.entityId)||0)+1); }
    }
    out.distinctEntities=entities.size;
    for(const n of entities.values()) if(n>1) out.entitiesWithSeveralTokens++;
    return out;
  }

  // Amazon embeds the actorName sent in the request inside contextValidatorToken
  // (page 1 is requested without actorName → "Milanes.ss"; pages 2+ with the
  // profile name → "Mila.Desk"). A conversation that crosses the page-1 boundary
  // therefore gets a new ctx: key. Verified 2026-11-02: 1,336 rows, 1,115 entities,
  // 221 entities stored twice (one row per context). The entity id is the stable
  // identity; these helpers map it back to the key already stored in Supabase.

  // rows: [{amazon_channel_key, updated_at}] → {entityId: most recently updated key}
  function buildEntityKeyMap(rows){
    const map={}, at={};
    for(const row of rows||[]){
      const key=String(row?.amazon_channel_key||"");
      const entity=extractEntityId(key);
      if(!entity) continue;
      const time=Date.parse(row?.updated_at||"")||0;
      if(!(entity in map) || time>at[entity]){ map[entity]=key; at[entity]=time; }
    }
    return map;
  }

  // Key to persist for a channel: the existing row for the same entity when there
  // is one (no new duplicate row), otherwise the usual ctx:<token>.
  function resolveStorageKey(channel, keyByEntity){
    const fresh=conversationStorageKey(channel);
    const entity=extractEntityId(channel?.contextValidatorToken);
    const existing=entity && keyByEntity ? keyByEntity[entity] : "";
    return {key:existing||fresh,entity,reused:!!existing && existing!==fresh};
  }

  // --- Fast conversation analysis (25.9.0) ---------------------------------------
  // Amazon's conversation index carries lastMsgTimeStamp (epoch ms, verified
  // 2026-11-03) and lists conversations newest first. 25.2.x read lastActivityAt /
  // lastMessageAt, which do not exist, so last_activity_at was always empty.
  function lastMessageIso(channel){
    const ms=Number(channel?.lastMsgTimeStamp);
    return Number.isFinite(ms) && ms>1e12 ? new Date(ms).toISOString() : null;
  }

  // rows: [{amazon_channel_key, updated_at, last_activity_at}] → per Amazon entity,
  // the stored key to reuse and the newest last activity already analyzed.
  function buildEntityIndex(rows){
    const keyByEntity=buildEntityKeyMap(rows);
    const lastActivityByEntity={};
    for(const row of rows||[]){
      const entity=extractEntityId(row?.amazon_channel_key);
      const ms=Date.parse(row?.last_activity_at||"");
      if(!entity || !Number.isFinite(ms)) continue;
      if(!(entity in lastActivityByEntity) || ms>lastActivityByEntity[entity]) lastActivityByEntity[entity]=ms;
    }
    return {keyByEntity,lastActivityByEntity};
  }

  // "Actualizar conversaciones": analyze a conversation only when it is new, was
  // never analyzed with a date, or has a message newer than the stored one.
  function needsAnalysis(channel,knownLastActivityMs){
    const ms=Number(channel?.lastMsgTimeStamp);
    if(!Number.isFinite(ms) || ms<=0) return true;
    if(knownLastActivityMs==null || !Number.isFinite(Number(knownLastActivityMs))) return true;
    return ms>Number(knownLastActivityMs)+1000;
  }

  // PostgREST bulk upserts need the same columns in every row of one request.
  function groupRowsByColumns(rows){
    const groups=new Map();
    for(const row of rows||[]){
      const signature=Object.keys(row).sort().join(",");
      if(!groups.has(signature)) groups.set(signature,[]);
      groups.get(signature).push(row);
    }
    return [...groups.values()];
  }

  // Run worker(item, index) over items with at most `concurrency` in flight. The
  // first error stops new work; it is rethrown once the running ones finish.
  async function runPool(items,worker,{concurrency=3}={}){
    let next=0, failure=null;
    const lane=async()=>{
      while(!failure && next<items.length){
        const index=next++;
        try{ await worker(items[index],index); }
        catch(error){ if(!failure) failure=error; }
      }
    };
    await Promise.all(Array.from({length:Math.max(1,Math.min(concurrency,items.length))},lane));
    if(failure) throw failure;
  }

  // Prefer results from the current local analysis, then the most recently updated.
  // Last activity in Amazon of a result. Supabase writes "2026-11-05 03:58:02.036+00",
  // which not every engine parses, so it is turned into ISO first.
  const activityMs=r=>Date.parse(String(r?.fechaActividad||"").trim().replace(" ","T").replace(/([+-]\d{2})$/,"$1:00"))||0;
  function preferResult(candidate, current){
    // A conversation seen with newer activity wins wherever it comes from: a browser that
    // analyzed before the brand replied must not hide the reply another copy saved in the
    // cloud (AOC, reported by the owner 2026-11-12). Same or unknown activity: as before.
    const a=activityMs(candidate), b=activityMs(current);
    if(a&&b&&a!==b) return a>b;
    const candidateLocal=candidate?.source!=="cloud", currentLocal=current?.source!=="cloud";
    if(candidateLocal!==currentLocal) return candidateLocal;
    return (Date.parse(candidate?.updatedAt||"")||0)>(Date.parse(current?.updatedAt||"")||0);
  }

  // One entry per Amazon conversation for display and counters. Rows without an
  // entity are kept as they are. Nothing is deleted from storage or Supabase.
  // Cloud and this browser's results by conversation key: the browser's copy only replaces
  // the cloud's when it is not older (preferResult).
  function mergeCloudAndLocalResults(cloud,local){
    const out={...(cloud||{})};
    for(const [key,result] of Object.entries(local||{})) if(!(key in out)||preferResult(result,out[key])) out[key]=result;
    return out;
  }
  function dedupeResultsByEntity(results){
    const out={}, byEntity=new Map();
    let duplicates=0;
    for(const [key,result] of Object.entries(results||{})){
      const entity=result?.amazonEntityId||extractEntityId(key);
      if(!entity){ out[key]=result; continue; }
      const previous=byEntity.get(entity);
      if(!previous){ byEntity.set(entity,{key,result}); continue; }
      duplicates++;
      if(preferResult(result,previous.result)) byEntity.set(entity,{key,result});
    }
    for(const {key,result} of byEntity.values()) out[key]=result;
    return {results:out,duplicates};
  }

  // Build the creator_conversations upsert payload. Columns without a real value are
  // omitted so PostgREST's merge-duplicates never overwrites stored data with null.
  function buildConversationUpsertRow(row, userId){
    if(!row?.amazon_channel_key || !userId) return null;
    const payload={
      user_id:userId,
      amazon_channel_key:String(row.amazon_channel_key),
      brand_name:String(row.brand_name||""),
      classification:String(row.classification||"REVISAR"),
      total_messages:Number(row.total_messages)||0,
      brand_messages:Number(row.brand_messages)||0,
      creator_messages:Number(row.creator_messages)||0,
      updated_at:new Date().toISOString()
    };
    if(row.last_sender) payload.last_sender=String(row.last_sender);
    if(row.last_activity_at) payload.last_activity_at=row.last_activity_at;
    if(row.conversation_url) payload.conversation_url=String(row.conversation_url);
    // Amazon entity id (column added 2026-11-03): only in the exact format the
    // database accepts, so a bad value never makes the whole upsert fail.
    const entity=row.amazon_entity_id||extractEntityId(String(row.amazon_channel_key).replace(/^ctx:/,""));
    if(/^\d+#ENTITY[A-Za-z0-9_-]+$/.test(String(entity||""))) payload.amazon_entity_id=String(entity);
    return payload;
  }

  // A result produced from a failed Amazon request must never replace cloud data.
  function shouldSyncResult(result){
    return !!result && !result.error && !!result.marca;
  }

  function isRetryableStatus(status){
    return !status || status===429 || status>=500;
  }

  async function retryAsync(task,{maxRetries=3,baseDelayMs=1500,sleep,shouldRetry=()=>true}={}){
    const wait=sleep||(ms=>new Promise(r=>setTimeout(r,ms)));
    let attempt=0;
    for(;;){
      try{ return await task(attempt); }
      catch(error){
        attempt++;
        if(attempt>maxRetries || !shouldRetry(error)) throw error;
        await wait(baseDelayMs*attempt);
      }
    }
  }

  // Paginate Amazon's /connect/api/chat/get index. fetchPage({page,nextToken,actorId})
  // must resolve to {status,data}. The request itself is built by the caller so the
  // exact parameters/headers used by 25.2.6 are preserved.
  // Never throws after page 1: a later failure returns the collected records with
  // complete:false and a stopReason, so the analysis can continue and be flagged.
  async function paginateConversationIndex({fetchPage,sleep,maxPages=100,pageDelayMs=250,maxRetries=3,retryBaseMs=1500,maxConsecutiveEmptyPages=3,onPage}={}){
    const wait=sleep||(ms=>new Promise(r=>setTimeout(r,ms)));
    const records=[], pageAudit=[], seenTokens=new Set();
    let nextToken=null, page=0, actorId="", complete=false, stopReason="", emptyRun=0, retries=0, lastError="";
    for(;;){
      page++;
      let response=null, attempt=0, failure="";
      for(;;){
        try{ response=await fetchPage({page,nextToken,actorId}); failure=""; }
        catch(error){ response=null; failure=String(error?.message||error); }
        const status=Number(response?.status||0);
        if(response && status>=200 && status<300) break;
        failure=failure||`HTTP ${status}`;
        if(!isRetryableStatus(status) || attempt>=maxRetries) break;
        attempt++; retries++;
        await wait(retryBaseMs*attempt);
      }
      const status=Number(response?.status||0);
      if(!(response && status>=200 && status<300)){
        lastError=failure;
        if(page===1){ const e=new Error(status===429?tr("Amazon limitó temporalmente las solicitudes (HTTP 429) al cargar la página 1."):tr("Amazon devolvió {failure} al cargar las conversaciones.",{failure})); e.status=status; throw e; }
        stopReason=status===429?"rate_limited":"page_error";
        break;
      }
      const data=response.data;
      const address=data?.responses?.[0]?.addresses?.[0];
      if(!address){
        if(page===1) throw new Error(tr("La respuesta de Amazon no contiene el listado de conversaciones esperado."));
        stopReason="invalid_response"; lastError="addresses[0] ausente";
        break;
      }
      if(!actorId) actorId=String(address.actorId||"").trim();
      const batch=Array.isArray(address.addressBook)?address.addressBook:[];
      records.push(...batch);
      nextToken=address.nextToken||null;
      const audit={
        page,
        addressBookCount:batch.length,
        cumulativeRecords:records.length,
        nextTokenPresent:Boolean(nextToken),
        nextTokenFieldPresent:Object.prototype.hasOwnProperty.call(address,"nextToken"),
        hasMore:address.hasMore??address.hasNextPage??data?.hasMore??data?.hasNextPage??null,
        totalCount:address.totalCount??address.totalRecords??data?.totalCount??data?.totalRecords??null,
        addressKeys:Object.keys(address).sort(),
        retries:attempt
      };
      pageAudit.push(audit);
      if(onPage) await onPage(audit,records.length);
      if(!nextToken){ complete=true; stopReason="no_next_token"; break; }
      if(!actorId){ stopReason="missing_actor_id"; break; }
      if(seenTokens.has(nextToken)){ stopReason="repeated_next_token"; break; }
      seenTokens.add(nextToken);
      emptyRun=batch.length?0:emptyRun+1;
      if(emptyRun>=maxConsecutiveEmptyPages){ stopReason="empty_pages"; break; }
      if(page>=maxPages){ stopReason="max_pages"; break; }
      await wait(pageDelayMs);
    }
    return {records,actorId,pages:page,complete,stopReason,pageAudit,retries,lastError};
  }

  function dedupeByContextToken(records){
    const channels=[], seen=new Set();
    let missing=0, duplicates=0;
    for(const item of records||[]){
      const key=String(item?.contextValidatorToken||"").trim();
      if(!key){ missing++; continue; }
      if(seen.has(key)){ duplicates++; continue; }
      seen.add(key); channels.push(item);
    }
    return {channels,missingContextValidatorToken:missing,duplicateContextValidatorToken:duplicates};
  }

  // Local keys that describe one Mila.Desk account and must not survive a logout.
  const USER_BOUND_LOCAL_KEYS=[
    "acaResultados","acaResultadosUserId","acaHistorialAnalisis","acaUltimoAnalisis","acaUltimoAnalisisGuardadoAt",
    "acaUltimoAnalisisNube","acaUltimoAnalisisNubeError","acaUltimoAnalisisNubeGuardadoAt","acaAnalysisHistoryCloudLoadedAt",
    "acaColaboraciones","acaColaboracionesUserId","acaSupabaseSync","acaUltimoErrorSupabase","acaUltimaMarcaSupabase",
    "acaSupabaseSyncFinishedAt","acaApiPaginationAudit","acaApiPaginationSummary","acaApiActorId","acaApiActorName",
    "acaKeyDiagnostics","acaConversacionesDetectadas","acaPaginasConversaciones","acaCloudConversationCount","acaCloudLoadedAt",
    "acaCloudRowCount","acaCloudDuplicateRowsHidden",
    "acaUltimaMarcaAbierta","acaUltimaBusqueda","acaCreatorConnectionsUrl","acaSourceUrl","acaApiPhase3Test",
    "acaFechaInicio","acaFechaFin","acaUltimaMarca","acaHasAnalyzed","acaProcesadas","acaTotalEsperado"
  ];

  // Backup content limited to the current account: other users' scoped caches and
  // the in-progress run bookkeeping are excluded.
  function filterBackupData(data, currentUserId){
    const out={};
    for(const [key,value] of Object.entries(data||{})){
      const scoped=key.match(/^milaVi:user:([^:]+):/);
      if(scoped && scoped[1]!==currentUserId) continue;
      if(/^acaAnalysis(RunId|OwnerUserId|CancelledRunId)$/.test(key)) continue;
      if(["acaProcesadas","acaTotalEsperado","acaEstadoProceso","acaUltimaMarca","milaKeptSession"].includes(key)) continue;
      out[key]=value;
    }
    return out;
  }

  // Restored backups may not inject another account's scoped data.
  function filterRestoreData(data, currentUserId){
    const out=filterBackupData(data,currentUserId);
    if(out.acaResultadosUserId && out.acaResultadosUserId!==currentUserId){
      for(const key of USER_BOUND_LOCAL_KEYS) delete out[key];
    }
    if(out.acaColaboracionesUserId && out.acaColaboracionesUserId!==currentUserId){
      delete out.acaColaboraciones; delete out.acaColaboracionesUserId;
    }
    return out;
  }

  const ACTIVE_ANALYSIS_STATES=["OBTENIENDO_CONVERSACIONES","PROCESANDO_API","ABRIENDO_CHAT","PROCESANDO","PROBANDO_MENSAJES"];

  // An "in progress" state whose heartbeat is older than maxIdleMs belongs to a
  // run whose tab was closed or reloaded; it must not block a new analysis forever.
  function isAnalysisActive(state, lastSavedIso, now=Date.now(), maxIdleMs=5*60*1000){
    if(!ACTIVE_ANALYSIS_STATES.includes(String(state||""))) return false;
    const last=Date.parse(lastSavedIso||"");
    if(!Number.isFinite(last)) return false;
    return now-last<maxIdleMs;
  }
  // Words for the user while an analysis runs; "" for any other state.
  function analysisStatusLabel(state, mode){
    const current=String(state||"");
    if(!ACTIVE_ANALYSIS_STATES.includes(current)) return "";
    if(current==="OBTENIENDO_CONVERSACIONES") return  tr("Buscando tus conversaciones en Amazon…");
    return mode==="update"?tr("Actualización en curso…"):tr("Análisis en curso…");
  }
  // Words for the user when an analysis or an update ends.
  function analysisFinishedLabel(state, mode){
    const update=mode==="update";
    if(state==="COMPLETADO_CON_REVISAR") return update?tr("Actualización finalizada con revisiones"):tr("Análisis finalizado con revisiones");
    return update?tr("Actualización completada"):tr("Análisis completado");
  }

  // --- Video Intelligence display helpers (pure; shared by every Amazon page) ---

  function formatMoney(value){
    if(value==null || value==="") return "—";
    const n=Number(value);
    return Number.isFinite(n)?`$${n.toFixed(2)}`:"—";
  }

  // Compact lower bound for an estimated monthly revenue (bought bracket × price).
  // Always rounds DOWN: "+" means "at least", so $4,998 is "$4.9K+", never "$5K+".
  function formatRevenueFloor(value){
    const n=Number(value);
    if(value==null || !Number.isFinite(n) || n<=0) return "—";
    const compact=(amount,unit,big)=>{
      const scaled=big?Math.floor(amount/unit):Math.floor(amount/unit*10)/10;
      return String(scaled).replace(/\.0$/,"");
    };
    if(n>=1000000) return `≈ $${compact(n,1000000,n>=10000000)}M+`;
    if(n>=1000) return `≈ $${compact(n,1000,n>=100000)}K+`;
    return `≈ $${Math.floor(n)}+`;
  }

  // Monthly revenue estimate: only when Amazon showed both the bought bracket and a price.
  function estimateMonthlyRevenue(price, bought){
    const p=Number(price), b=Number(bought);
    if(price==null || bought==null || !Number.isFinite(p) || !Number.isFinite(b) || p<=0 || b<=0) return null;
    return p*b;
  }

  // --- Onsite commission (videos and Storefront are "Onsite Content") ---------
  // Amazon only returns the STANDARD (offsite) rate of a product, without its
  // category. Sales from content on Amazon pay the ONSITE rate (Associates
  // Central, "Onsite Commission Income", Table A, checked 2026-11-03). Several
  // categories share a standard rate but not an onsite rate, so the product's top
  // breadcrumb narrows it down; when it still is ambiguous a range is returned.
  const normCategory=s=>String(s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"");
  const ONSITE_RULES={
    // standard % → [crumb rules], fallback [min,max]
    10:{rules:[],fallback:[4,4]},
    5:{rules:[],fallback:[1.25,1.25]},
    4.5:{rules:[[/libros|books/,0.5,0.5]],fallback:[1.25,1.25]},
    4:{rules:[[/dispositivos amazon|amazon devices|kindle|fire tv|fire tablet/,0.5,1]],fallback:[1,1]},
    3:{rules:[
      [/hogar y cocina|home ?(&|and) ?kitchen|muebles|furniture|animales|mascotas|pet supplies|patio|cesped|jardin|lawn|garden/,3,3],
      [/juguetes|toys|bebe|baby/,0.5,0.5],
      [/belleza|beauty|instrumentos musicales|musical instruments|industrial|cientific|scientific/,2,2],
      [/electronica|electronics/,1,1],
      [/deportes|sports|aire libre|outdoors/,0.75,1.25],
      [/herramientas|mejoras del hogar|tools|home improvement/,1.75,3]
    ],fallback:[0.5,3]},
    2.5:{rules:[],fallback:[0.5,0.5]},
    2:{rules:[],fallback:[0.5,0.5]},
    1:{rules:[[/salud|health/,1.25,1.25],[/alimentos|comestibles|grocery|videojuegos|video games/,0.5,0.5]],fallback:[0.5,1.25]},
    0:{rules:[],fallback:[0,0]}
  };

  // standardPercent: e.g. 3 for 3 %. crumbs: product breadcrumbs (top first).
  function onsiteRateRange(standardPercent, crumbs){
    if(standardPercent==null || standardPercent==="") return null;
    const std=Math.round(Number(standardPercent)*100)/100;
    const entry=ONSITE_RULES[std];
    if(!Number.isFinite(std) || !entry) return null;
    const top=normCategory(Array.isArray(crumbs)?crumbs[0]:"");
    for(const [re,min,max] of entry.rules) if(top && re.test(top)) return {min,max,exact:min===max};
    const [min,max]=entry.fallback;
    return {min,max,exact:min===max};
  }

  // In English: "40.5%"; in Spanish: "40,5 %".
  const english=()=>root.MilaI18n?.getLanguage?.()==="en";
  function formatPercentEs(n){
    const v=Math.round(Number(n)*100)/100;
    return english()?`${v}%`:`${String(v).replace(".",",")} %`;
  }

  // "$0.70 onsite (1 %) · $7.70 con campaña" or a range when the rate is ambiguous.
  function formatOnsiteCommission({price,standardPercent,crumbs,campaignPercent}={}){
    const p=Number(price);
    if(price==null || price==="" || !Number.isFinite(p) || p<=0) return "—";
    const range=onsiteRateRange(standardPercent,crumbs);
    if(!range) return "—";
    const extra=Number(campaignPercent)>0?Number(campaignPercent):0;
    const amount=(rate)=>formatMoney(p*rate/100);
    const money=(a,b)=>a===b?amount(a):`${amount(a)}–${amount(b)}`;
    const pct=range.exact?formatPercentEs(range.min):`${english()?String(range.min):String(range.min).replace(".",",")}–${formatPercentEs(range.max)}`;
    let text=`${money(range.min,range.max)} onsite (${pct})`;
    if(extra>0) text+=tr(" · {money} con campaña",{money:money(range.min+extra,range.max+extra)});
    return text;
  }

  // Why a video position could not be verified (shown under "No verificado").
  function placementUnverifiedReason(p){
    if(!p) return "";
    if(p.error) return String(p.error);
    const galleryKnown=p.topUnknown!==true && p.topTotal!=null;
    const carouselKnown=p.carouselTotal!=null;
    if(!galleryKnown && !carouselKnown) return  tr("Amazon no devolvió la galería ni el carrusel del producto");
    if(!galleryKnown) return  tr("Amazon no devolvió la galería principal del producto");
    if(!carouselKnown) return  tr("Amazon no devolvió el carrusel del producto");
    return "";
  }

  // --- Video placement (phase 3) ------------------------------------------------
  // Verified on a live product page (2026-11-02): the gallery and the carousel list
  // the brand's own video first with a different id format
  // (amzn1.ive.seller.video.<hex>), and Amazon reorders creator videos on every
  // request. Positions therefore count the brand video and are a snapshot.
  const CREATOR_VIDEO_RE=/^amzn1\.vse\.video\.[a-f0-9]{32}$/i;
  const BRAND_VIDEO_RE=/^amzn1\.ive\.seller\.video\.[a-f0-9]{32}$/i;
  function isCreatorVideoId(id){ return CREATOR_VIDEO_RE.test(String(id||"")); }
  function isBrandVideoId(id){ return BRAND_VIDEO_RE.test(String(id||"")); }
  function isProductVideoId(id){ return isCreatorVideoId(id) || isBrandVideoId(id); }

  // Gallery: HTML returned by Amazon's related-videos component → ordered video ids.
  function parseRelatedVideosHtml(html){
    const ids=[];
    const cardRe=/<li\b[^>]*class="[^"]*vse-video-card[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
    let match;
    while((match=cardRe.exec(String(html||"")))){
      const id=(match[1].match(/data-aci-content-id="([^"]+)"/i)||[])[1];
      if(isProductVideoId(id) && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  // Every card of the related-videos HTML with who made it: type is seller (brand),
  // influencer or customer; name drops Amazon's "💎 Top Creator 💎" mark, kept in top.
  function parseRelatedVideoCards(html){
    const h=String(html||""), starts=[...h.matchAll(/<li\b[^>]*vse-video-card/gi)].map(m=>m.index), out=[];
    starts.forEach((at,i)=>{
      const chunk=h.slice(at,starts[i+1]??h.length);
      const attr=n=>((chunk.match(new RegExp(`data-${n}="([^"]*)"`,"i"))||[])[1]||"");
      const id=attr("aci-content-id"), raw=attr("vendor-name").replace(/&amp;/g,"&");
      if(id) out.push({id,type:attr("creator-type").toLowerCase(),name:raw.replace(/💎|Top Creator/gi,"").replace(/\s+/g," ").trim(),top:/Top Creator/i.test(raw)});
    });
    return out;
  }
  // Cards merged from several requests (+ the page carousel) → what the product card shows.
  function summarizeVideoPool(cards,{carousel=[],complete=false}={}){
    const videos=new Set(),names=new Set(),tops=new Set(),brand=new Set(),customer=new Set();
    for(const c of cards||[]){
      const type=c?.type||(isCreatorVideoId(c?.id)?"influencer":"");
      if(type==="influencer"){ videos.add(c.id); const n=String(c.name||"").toLowerCase(); if(n){ names.add(n); if(c.top) tops.add(n); } }
      else if(type==="seller") brand.add(c.id);
      else if(type==="customer") customer.add(c.id);
    }
    for(const id of carousel||[]) if(isCreatorVideoId(id)) videos.add(id);
    return {influencers:names.size||videos.size,videos:videos.size,topCreators:tops.size,brandVideos:brand.size,customerVideos:customer.size,complete:!!complete};
  }
  // Best Sellers Rank text of the product details → the most specific rank (the last one).
  function parseBestSellersRank(text){
    const t=String(text||"").replace(/\s+/g," ");
    let last=null;
    for(const m of t.matchAll(/(?:#|n[º°]\s?)([\d][\d,.]*)\s+(?:in|en)\s+(.+?)(?=\s*\(|\s*#\d|\s*n[º°]\s?\d|$)/gi)){
      const rank=Number(m[1].replace(/[,.]/g,""));
      if(rank>0) last={rank,category:m[2].trim()};
    }
    return last;
  }

  // Carousel: video ids embedded in the product page, in page order.
  function extractCarouselIds(html){
    const ids=[];
    for(const m of String(html||"").matchAll(/"aciContentId"\s*:\s*"([^"]+)"/gi)){
      if(isProductVideoId(m[1]) && !ids.includes(m[1])) ids.push(m[1]);
    }
    return ids;
  }

  // Amazon shows a random part of a product's videos on every load (checked live 2026-11-23:
  // 7 of 9 in the gallery, 12 of 27 in the carousel), so one look can miss a video that is
  // there. Look up to `max` times, joining what appears; stop as soon as `aci` shows up or
  // after `quietStop` looks in a row bring nobody new. A failed look after the first ends it.
  async function sampleVideoIds(fetchIds,{aci=null,max=4,quietStop=2}={}){
    const ids=[]; let checks=0, quiet=0;
    while(checks<max){
      let found;
      try{ found=await fetchIds(checks); }catch(error){ if(!checks) throw error; break; }
      checks++;
      let added=0;
      for(const id of found||[]) if(!ids.includes(id)){ ids.push(id); added++; }
      if(aci&&ids.includes(aci)) break;
      quiet=added?0:quiet+1;
      if(quiet>=quietStop) break;
    }
    return {ids,checks};
  }

  // 📊 How often a video shows (owner's request 2026-11-27): some videos show on almost every visit,
  // others only now and then, and «it showed once» hid that. Each look at the product page adds
  // {at, gc, gh, cc, ch}: gallery and carousel requests made and whether the video was in one
  // (0/1: a look stops when it appears). Requests until the first appearance estimate the rate
  // without bias (hits / requests). Kept 30 days, at most 60 looks per video and product.
  const PRESENCE_DAYS=30;
  function presenceAdd(list,sample,now=Date.now()){
    const keep=(Array.isArray(list)?list:[]).filter(s=>s&&now-Number(s.at)<PRESENCE_DAYS*864e5);
    const n=v=>Math.max(0,Math.min(40,Math.round(Number(v)||0)));
    // A normal look stops when the video appears (hits 0/1); «Revisar a fondo» counts every request.
    const hit=(h,c)=>Math.min(c,h===true?1:n(h));
    const s={at:now,gc:n(sample?.gc),cc:n(sample?.cc)}; s.gh=hit(sample?.gh,s.gc); s.ch=hit(sample?.ch,s.cc);
    if(s.gc||s.cc) keep.push(s);
    return keep.slice(-60);
  }
  // → {looks, rate (0–1, per visit: gallery or carousel), outOf10, level: strong|intermittent|weak|few}
  function presenceStats(list,now=Date.now()){
    const looks=(Array.isArray(list)?list:[]).filter(s=>s&&now-Number(s.at)<PRESENCE_DAYS*864e5);
    const sum=k=>looks.reduce((t,s)=>t+(Number(s[k])||0),0);
    const gc=sum("gc"),gh=sum("gh"),cc=sum("cc"),ch=sum("ch");
    const pg=gc?gh/gc:0, pc=cc?ch/cc:0;
    const rate=gc||cc?1-(1-pg)*(1-pc):null;
    const level=looks.length<3||rate==null?"few":rate>=0.6?"strong":rate>=0.3?"intermittent":"weak";
    return {looks:looks.length,rate,outOf10:rate==null?null:Math.round(rate*10),level};
  }

  // Before and after she changed the title (owner's request 2026-11-27): titles seen in her video
  // list, with the date Mila.Desk first saw a new one. → new log {aci: {title, changedAt}}.
  function titleLogUpdate(log,videos,now=Date.now()){
    const out={...(log&&typeof log==="object"?log:{})};
    for(const v of videos||[]){
      const title=String(v?.title||"").trim().slice(0,300), aci=String(v?.aci||"");
      if(!aci||!title) continue;
      const old=out[aci];
      out[aci]=!old?{title,changedAt:null}:old.title!==title?{title,changedAt:now,before:old.title.slice(0,120)}:old;
    }
    return out;
  }
  // Looks before and after a date → {before, after} stats («few» when there are not enough).
  function presenceSplit(list,at,now=Date.now()){
    const l=Array.isArray(list)?list:[];
    return {before:presenceStats(l.filter(s=>Number(s.at)<at),now),after:presenceStats(l.filter(s=>Number(s.at)>=at),now)};
  }
  function presenceChangeText(split,changedAt,now=Date.now()){
    if(!split||!changedAt) return "";
    const days=Math.max(0,Math.floor((now-changedAt)/864e5));
    const n=st=>st.level==="few"?tr("todavía pocos datos"):tr("{n} de cada 10",{n:st.outOf10});
    return tr("Cambiaste el título hace {d} días. Antes salía: {before}. Desde el cambio: {after}.",{d:days,before:n(split.before),after:n(split.after)});
  }
  function presenceText(st){
    if(!st) return "";
    const looks=tr(Number(st.looks)===1?"{n} revisión":"{n} revisiones",{n:st.looks});
    if(st.level==="few") return tr("Pocos datos para saber cuántas veces sale ({looks} en 30 días).",{looks});
    const name={strong:tr("se mantiene"),intermittent:tr("sale a ratos"),weak:tr("sale poco")}[st.level];
    return tr("Sale en {n} de cada 10 visitas: {name} ({looks} en 30 días).",{n:st.outOf10,name,looks});
  }

  // gallery: ordered ids or null when Amazon did not return the gallery.
  function computeVideoPlacement({aci,gallery,carousel,galleryChecks=1,carouselChecks=1}={}){
    const galleryKnown=Array.isArray(gallery);
    const g=galleryKnown?gallery:[];
    const c=Array.isArray(carousel)?carousel:[];
    const topAt=aci?g.indexOf(aci):-1, carAt=aci?c.indexOf(aci):-1;
    const top=topAt>=0, bottom=carAt>=0;
    return {
      position:!galleryKnown?"UNKNOWN":top&&bottom?"BOTH":top?"TOP":bottom?"BOTTOM":"NEITHER",
      topIndex:top?topAt+1:null, topTotal:galleryKnown?g.length:null, topUnknown:!galleryKnown,
      topBrandCount:galleryKnown?g.filter(isBrandVideoId).length:null,
      carouselIndex:bottom?carAt+1:null, carouselTotal:c.length,
      carouselBrandCount:c.filter(isBrandVideoId).length,
      galleryChecks:galleryKnown?galleryChecks:0, carouselChecks
    };
  }

  // "¿Vale la pena grabar?" on the product page (beta tester Marling's request, 2026-11-16):
  // monthly sales + influencers who already have a video + an open campaign → one verdict.
  // Only people count (owner, 2026-11-17: competition is who earns commission, not videos);
  // complete=false: the sampling still found new people, so the count reads "or more".
  function recordAdvice({bought,influencers,complete=true,hasCampaign}={}){
    const b=bought==null||bought===""?null:Number(bought), v=influencers==null?null:Number(influencers);
    const demand=!Number.isFinite(b)?"unknown":b>=500?"high":b>=100?"mid":"low";
    const competition=!Number.isFinite(v)?"unknown":v<=3?"low":v<=10?"mid":"high";
    let tone="maybe";
    if((demand==="high"&&competition!=="high")||(demand==="mid"&&competition==="low")||(hasCampaign&&(demand==="high"||demand==="mid"))) tone="good";
    else if((demand==="low"&&!hasCampaign)||((demand==="unknown"||demand==="low")&&competition==="high")) tone="bad";
    const d={high:tr("Se vende bien"),mid:tr("Se vende algo"),low:tr("Se vende poco"),unknown:tr("Amazon no muestra sus ventas")}[demand];
    const c={low:tr("hay pocos videos de creadores"),mid:tr("ya hay varios videos de creadores"),high:tr("ya hay muchos videos de creadores"),unknown:tr("no se pudieron contar los videos")}[competition];
    const more=!complete;
    return {tone,demand,competition,
      title:{good:tr("Buena opción para grabar"),maybe:tr("Puede funcionar"),bad:tr("Mejor busca otro producto")}[tone],
      why:tr("{a} y {b}.",{a:d,b:c})+(hasCampaign?" "+tr("Tiene campaña disponible: ganas un extra."):""),
      demandLabel:{high:tr("BUENAS"),mid:tr("MEDIAS"),low:tr("BAJAS"),unknown:tr("SIN DATO")}[demand],
      competitionLabel:{low:tr("POCA COMPETENCIA"),mid:tr("COMPETENCIA MEDIA"),high:tr("MUCHA COMPETENCIA"),unknown:tr("SIN DATO")}[competition],
      videosText:v==null||!Number.isFinite(v)?"—":more?tr("{n} o más",{n:v}):String(v)};
  }

  // 🔥 «¿Vale la pena grabar?» (owner's request 2026-11-22): a 1–10 score from what Mila.Desk
  // knows (monthly sales Amazon shows, creator videos already there, open campaign, whether
  // the creator owns it or already has a video). A guide, not an Amazon number.
  function recordScore({bought=null,influencers=null,campaignPercent=0,haveIt=false,hasVideo=false}={}){
    const b=bought==null||bought===""?NaN:Number(bought), v=influencers==null||influencers===""?NaN:Number(influencers), c=Number(campaignPercent)||0;
    let s=1; const why=[];
    if(!Number.isFinite(b)){ s+=1.5; why.push(tr("Amazon no muestra sus ventas")); }
    else if(b>=1000){ s+=4; why.push(tr("se vende mucho")); } else if(b>=500){ s+=3; why.push(tr("se vende bien")); }
    else if(b>=100){ s+=2; why.push(tr("se vende algo")); } else { s+=.5; why.push(tr("se vende poco")); }
    if(!Number.isFinite(v)){ s+=1; } else if(v<=3){ s+=3; why.push(tr("casi no tiene videos de creadores")); }
    else if(v<=10){ s+=2; why.push(tr("tiene algunos videos de creadores")); } else if(v<=20){ s+=1; why.push(tr("ya tiene muchos videos")); }
    else why.push(tr("ya tiene demasiados videos"));
    if(c>=10){ s+=2; why.push(tr("campaña de +{pct} %",{pct:c})); } else if(c>0){ s+=1; why.push(tr("campaña de +{pct} %",{pct:c})); }
    if(haveIt){ s+=1; why.push(tr("ya lo tienes en casa")); }
    if(hasVideo){ s-=3; why.push(tr("ya tienes un video de este producto")); }
    const score=Math.max(1,Math.min(10,Math.round(s)));
    return {score,tone:score>=7?"good":score>=4?"maybe":"bad",why};
  }

  // Second line under the placement badge (option A). The brand video is counted in
  // the numbers but not mentioned (owner found it redundant, 25.6.1); only the
  // rotation warning remains, and only when the video is listed.
  function placementContextNote(p){
    if(!p) return "";
    const listed=Number(p.topIndex)>0 || Number(p.carouselIndex)>0;
    return listed ? tr("El orden de los creadores rota") : "";
  }

  // --- Video Intelligence engine (phase 4: Mila.Desk's own design) -------------

  // Request pacing by reservation: every caller books the next free slot
  // synchronously, so concurrent callers never share a slot and need no queue.
  function createPacer([minGapMs,maxGapMs],{now=()=>Date.now(),random=Math.random}={}){
    let nextFreeAt=0;
    return {
      reserve(){
        const start=Math.max(now(),nextFreeAt);
        nextFreeAt=start+minGapMs+random()*(maxGapMs-minGapMs);
        return Math.max(0,start-now());
      }
    };
  }

  // Which pacing class an Amazon URL belongs to.
  function amazonRequestClass(url){
    const m=String(url||"").match(/^https?:\/\/([^/?#]+)([^?#]*)/i);
    const host=(m?.[1]||"").toLowerCase(), path=m?.[2]||"/";
    if(host==="data.amazon.com" || path.startsWith("/connect/api/")) return "api";
    if(path.startsWith("/vap/ew/subcomponent/") || path.startsWith("/creators/links/render/")) return "component";
    return "page";
  }

  // Generic token pagination. fetchPage(pageNumber, token) → {items, nextToken}.
  // A failure on page 1 is thrown; a later one ends the walk and is reported.
  async function walkTokenPages(fetchPage,{maxPages=20}={}){
    const items=[]; let token=null, pages=0, partialError=null;
    while(pages<maxPages){
      let page;
      try{ page=await fetchPage(pages+1,token); }
      catch(error){ if(pages===0) throw error; partialError=error; break; }
      pages++;
      const batch=Array.isArray(page?.items)?page.items:[];
      items.push(...batch);
      token=page?.nextToken||null;
      if(!token || !batch.length) break;
    }
    return {items,pages,partialError};
  }

  const asinList=list=>Array.isArray(list)?list.filter(a=>/^[A-Z0-9]{10}$/.test(String(a))):[];
  const epochOrNull=v=>Number(v)||null;

  // One accepted Creator Connections campaign (collaboration/search row).
  function toJoinedCampaign(ad,creatorId){
    if(!ad?.campaignId) return null;
    const id=String(ad.campaignId);
    return {
      campaignId:id,
      adId:String(ad.adId||ad.adDetails?.adId||ad.adDetailsWithCampaignInfo?.adDetails?.adId||id),
      status:ad.adStatus||"",
      campaignStatus:ad.campaignStatus||ad.campaignDetails?.campaignStatus||"",
      brand:ad.brandName||"", name:ad.campaignName||"",
      ratePercent:Number(ad.commissionPercentage)||0, creatorId,
      asins:asinList(ad.campaignAsins),
      start:epochOrNull(ad.startDateTimeInEpochMills),
      end:epochOrNull(ad.actualEndDateTimeInEpochMills||ad.scheduledEndDateTimeInEpochMills),
      // Content the creator submitted (25.45.0): 0 is Amazon's «Contenido no enviado aún»
      // (seen on the owner's account 2026-11-12); null when Amazon did not say.
      contentCount:Array.isArray(ad.creatorContentDetails)?ad.creatorContentDetails.length:null
    };
  }

  function uniqueBy(list,keyOf){
    const seen=new Set(), out=[];
    for(const item of list||[]){ const k=item&&keyOf(item); if(!k || seen.has(k)) continue; seen.add(k); out.push(item); }
    return out;
  }

  // campaign/search response → flat rows (grouped or not by brand).
  function campaignSearchRows(raw){
    const groups=raw?.responses?.[0]?.campaignsByBrand;
    if(!groups || typeof groups!=="object") return [];
    return Object.values(groups).flatMap(g=>Array.isArray(g)?g:Object.values(g||{}));
  }

  // Open opportunities for one ASIN: still recruiting and not already joined.
  function toOpenOpportunities(rows,asin,joinedIds=new Set()){
    const out=[];
    for(const c of rows||[]){
      const asins=asinList(c?.campaignAsins);
      if(!c?.campaignId || !asins.includes(asin)) continue;
      const accepted=Number(c.numberOfCreatorsAccepted), required=Number(c.numberOfCreatorsRequired);
      const full=!!c.fullyClaimed || (required>0 && accepted>=required);
      if(full || joinedIds.has(String(c.campaignId))) continue;
      out.push({
        campaignId:String(c.campaignId), brand:c.brandName||"", name:c.campaignName||"",
        ratePercent:Number(c.commissionPercentage)||0, status:c.campaignStatus||"",
        start:epochOrNull(c.startDateTimeInEpochMills),
        end:epochOrNull(c.actualEndDateTimeInEpochMills||c.scheduledEndDateTimeInEpochMills),
        accepted, required, fullyClaimed:!!c.fullyClaimed, providingSample:!!c.providingSample, asins
      });
    }
    return out;
  }

  // «Aceptar» (25.44.0, owner's request 2026-11-12): what Amazon's own page sends to
  // /connect/api/campaign/accept, seen on 2026-11-11 — {campaignId, campaignType} plus
  // campaignQualifier for BOUNTY_BOARD campaigns. Built only from Amazon's fresh search row
  // for the product, and only while the campaign is open, has spots and includes it.
  function campaignAcceptBody(rows,campaignId,asin,joinedIds=new Set()){
    const id=String(campaignId||"");
    const c=(rows||[]).find(r=>String(r?.campaignId||"")===id);
    if(!c) return {error:"gone"};
    if(joinedIds.has(id)) return {error:"joined"};
    if(!asinList(c.campaignAsins).includes(asin)) return {error:"asin"};
    const accepted=Number(c.numberOfCreatorsAccepted), required=Number(c.numberOfCreatorsRequired);
    if(c.fullyClaimed || (required>0 && accepted>=required)) return {error:"full"};
    if(c.campaignType!=="BOUNTY_BOARD" || !/^[A-Z_]{1,40}$/.test(String(c.campaignQualifier||""))) return {error:"type"};
    return {body:{campaignId:id,campaignType:"BOUNTY_BOARD",campaignQualifier:String(c.campaignQualifier)}};
  }

  function campaignLifecycle(c,now){
    const ended=!!(c?.end && c.end<now);
    const delivering=(c?.status==="DELIVERING" || c?.campaignStatus==="DELIVERING") && (!c.start || c.start<=now) && !ended;
    return {ended,delivering};
  }

  // Joined campaigns relevant to a product, best first: exact ASIN, then a
  // sibling variation, then same brand named in the title (unconfirmed). Inside a
  // group: currently delivering, then not ended, then higher commission.
  function matchJoinedCampaigns({ads,asin,siblings=[],productTitle="",now=Date.now()}){
    const family=new Set(siblings||[]);
    const compact=v=>String(v||"").toLowerCase().replace(/[^a-z0-9]/g,"");
    const title=compact(productTitle);
    const kindOf=ad=>{
      if(ad.asins.includes(asin)) return {match:"asin",tier:0};
      const sibling=ad.asins.find(a=>family.has(a));
      if(sibling) return {match:"variation",tier:1,matchedAsin:sibling};
      const brand=compact(ad.brand);
      if(title && brand.length>=3 && title.includes(brand)) return {match:"brand",tier:2,unsure:true};
      return null;
    };
    const scored=[];
    for(const ad of ads||[]){
      const kind=kindOf(ad); if(!kind) continue;
      const life=campaignLifecycle(ad,now);
      scored.push({ad,kind,live:life.delivering?2:life.ended?0:1});
    }
    scored.sort((x,y)=>x.kind.tier-y.kind.tier || y.live-x.live || (y.ad.ratePercent||0)-(x.ad.ratePercent||0));
    return scored.map(({ad,kind})=>{
      const {tier,...rest}=kind;
      return {...ad,...rest};
    });
  }

  // Decide the campaign shown for a product. Sources, in order of trust:
  // the joined-campaign list, then Earning Insights' accepted campaigns (used when
  // the list has no verified match and is stale or only matched by brand, or when
  // the list could not be read at all).
  function chooseProductCampaign({matches=[],earningCampaigns=[],joinedListAgeMs=Infinity,joinedError=null,siblings=[],creatorId=null,asin,now=Date.now()}){
    const acceptedEarning=(earningCampaigns||[]).filter(c=>c?.accepted);
    const fromEarning=(ei,source)=>({
      campaignId:ei.campaignId, adId:null, brand:ei.brand, name:"", accepted:true,
      ratePercent:Number(ei.rate)*100, end:ei.end, asins:[asin], match:"asin",
      status:"ACCEPTED", campaignStatus:"", source, linkVerified:false,
      state:ei.end && ei.end<now?"ENDED":"JOINED"
    });
    if(joinedError){
      const list=acceptedEarning.map(ei=>fromEarning(ei,"earning-insights-fallback"));
      return {campaign:list[0]?{...list[0],creatorId:null}:null,campaignMatches:list,relatedCampaign:null};
    }
    const verified=matches.filter(m=>m.match==="asin" || m.match==="variation");
    if(verified.length){
      const best=verified[0], life=campaignLifecycle(best,now);
      const campaign={campaignId:best.campaignId,adId:best.adId||best.campaignId,creatorId,
        brand:best.brand,name:best.name,accepted:true,state:life.ended?"ENDED":life.delivering?"DELIVERING":"JOINED",
        ratePercent:best.ratePercent,start:best.start,end:best.end,adStatus:best.status,campaignStatus:best.campaignStatus,
        match:best.match,source:"joined-campaign-list",linkVerified:true};
      const variant=matches.find(m=>m.match==="variation");
      const relatedCampaign=variant?{asin:variant.asins.find(a=>(siblings||[]).includes(a))||null,brand:variant.brand,
        campaignId:variant.campaignId,ratePercent:variant.ratePercent,end:variant.end,state:"OTHER_VARIANT",adId:variant.adId}:null;
      return {campaign,campaignMatches:matches,relatedCampaign};
    }
    const brandOnly=matches.some(m=>m.match==="brand");
    if((brandOnly || joinedListAgeMs>60*60*1000) && acceptedEarning.length){
      const confirmed=acceptedEarning.map(ei=>matches.find(m=>m.campaignId===ei.campaignId)||fromEarning(ei,"earning-insights-confirmed"));
      const first=confirmed[0];
      const campaign={...first,creatorId:first.creatorId||null,accepted:true,
        state:first.end && first.end<now?"ENDED":"JOINED",source:first.source||"earning-insights-confirmed"};
      const rest=matches.filter(m=>!confirmed.some(c=>c.campaignId===m.campaignId));
      return {campaign,campaignMatches:[...confirmed,...rest],relatedCampaign:null};
    }
    return {campaign:null,campaignMatches:matches,relatedCampaign:null};
  }

  // "N bought in past month" badges (search results), several languages.
  const BOUGHT_PHRASES=[
    "bought\\s+in\\s+(?:the\\s+)?past\\s+month",
    "comprad\\w*\\s+el\\s+mes\\s+pasado",
    "mal\\s+im\\s+letzten\\s+monat\\s+gekauft",
    "achet\\w*\\s+au\\s+cours\\s+du\\s+mois\\s+dernier",
    "acquistat\\w*\\s+nel\\s+mese\\s+scorso",
    "compras?\\s+no\\s+m[eê]s\\s+passado"
  ];
  const BOUGHT_RE=new RegExp(`(\\d[\\d.,]*)\\s*([km])?\\s*\\+?\\s*(?:${BOUGHT_PHRASES.join("|")})`,"i");
  function parseBoughtBadge(text){
    const m=String(text||"").replace(/ /g," ").replace(/\s+/g," ").match(BOUGHT_RE);
    if(!m) return null;
    const raw=m[1];
    const decimalComma=raw.includes(",") && !raw.includes(".") && /,\d{1,2}$/.test(raw);
    const n=Number(decimalComma?raw.replace(",","."):raw.replace(/,/g,""));
    if(!Number.isFinite(n) || n<=0) return null;
    const unit=(m[2]||"").toLowerCase();
    return Math.round(n*(unit==="k"?1000:unit==="m"?1000000:1));
  }

  function formatBoughtLabel(n){
    const v=Number(n);
    if(!Number.isFinite(v) || v<=0) return "";
    if(v>=1000000) return `${+(v/1000000).toFixed(1)}M+`;
    if(v>=1000) return `${+(v/1000).toFixed(1)}K+`;
    return `${v}+`;
  }

  // Demand seen on search tiles: within 3 days the highest observation wins,
  // so a tile without a badge (or a lower bracket) never erases a better one.
  function mergeDemandObservation(previous,observed,now=Date.now()){
    const keepMs=3*24*60*60*1000;
    if(previous?.bought!=null && now-Number(previous.savedAt)<keepMs && Number(previous.bought)>Number(observed.bought)){
      return {value:{bought:Number(previous.bought),boughtText:previous.boughtText||formatBoughtLabel(previous.bought)},stored:false};
    }
    const bought=Number(observed.bought);
    return {value:{bought,boughtText:observed.boughtText||formatBoughtLabel(bought)},stored:true};
  }

  // --- Price history (phase 2a: observed prices kept in this browser) ---------
  // Only prices actually seen on Amazon are stored; nothing is interpolated.
  const PRICE_KEEP_MS=60*24*60*60*1000;
  const PRICE_SAME_GAP_MS=6*60*60*1000;   // same price: at most one record per 6 h
  const PRICE_CHANGE_GAP_MS=30*60*1000;   // changed price: at most one record per 30 min
  const PRICE_MAX_OBS=120;
  // Video Intelligence caches in this browser that nothing will read again: price
  // histories with no price seen in 60 days, demand badges older than 7 days and any
  // other dated entry older than 14 days (all of them expire much sooner). Entries
  // without a date and keys outside "milaVi:" are never touched.
  function staleViCacheKeys(entries,now=Date.now()){
    const DAY=86400000, out=[];
    for(const [key,value] of Object.entries(entries||{})){
      if(!key.startsWith("milaVi:") || !value || typeof value!=="object") continue;
      if(key.startsWith("milaVi:price:")){
        if(!Array.isArray(value.obs)) continue;
        const latest=value.obs.reduce((max,o)=>Math.max(max,Number(o?.t)||0),0);
        if(now-latest>PRICE_KEEP_MS) out.push(key);
        continue;
      }
      const saved=Number(value.savedAt)||0;
      if(!saved) continue;
      if(now-saved>(key.startsWith("milaVi:bought:")?7:14)*DAY) out.push(key);
    }
    return out;
  }
  const MONTHS_ES=["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
  const MONTHS_EN=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  // "$1,234.56", "US$29.99", "29,99 €" → number. Amazon prices carry two decimals;
  // any other group after the last separator is a thousands separator.
  function parseAmazonPrice(text){
    const cleaned=String(text||"").replace(/[^\d.,]/g,"");
    if(!cleaned) return null;
    const last=Math.max(cleaned.lastIndexOf("."),cleaned.lastIndexOf(","));
    let n;
    if(last<0 || cleaned.length-last-1!==2) n=Number(cleaned.replace(/[.,]/g,""));
    else n=Number(cleaned.slice(0,last).replace(/[.,]/g,"")+"."+cleaned.slice(last+1));
    return Number.isFinite(n) && n>0 && n<1000000 ? Math.round(n*100)/100 : null;
  }

  // Returns {history, changed}. Old records (> 60 days) are dropped on every write.
  function addPriceObservation(history, {price,at,source}={}, now=Date.now()){
    const kept=(Array.isArray(history?.obs)?history.obs:[])
      .filter(o=>Number(o?.p)>0 && Number(o?.t)>0 && now-Number(o.t)<=PRICE_KEEP_MS);
    const pruned=kept.length!==(Array.isArray(history?.obs)?history.obs.length:0);
    const p=Math.round(Number(price)*100)/100;
    const t=Number(at)||now;
    const unchanged={history:pruned?{obs:kept}:history,changed:pruned};
    if(!(p>0) || p>=1000000 || t>now+60000) return unchanged;
    const last=kept[kept.length-1];
    if(last){
      const gap=t-Number(last.t);
      if(gap<0) return unchanged;
      if(Number(last.p)===p && gap<PRICE_SAME_GAP_MS) return unchanged;
      if(Number(last.p)!==p && gap<PRICE_CHANGE_GAP_MS) return unchanged;
    }
    const obs=[...kept,{p,t,s:String(source||"").slice(0,20)}].slice(-PRICE_MAX_OBS);
    return {history:{obs},changed:true};
  }

  function summarizePriceHistory(history, now=Date.now(), days=30){
    const cut=now-days*24*60*60*1000;
    const list=(Array.isArray(history?.obs)?history.obs:[])
      .filter(o=>Number(o?.p)>0 && Number(o?.t)>=cut && Number(o.t)<=now+60000)
      .sort((a,b)=>a.t-b.t);
    if(!list.length) return {state:"none",count:0};
    const prices=list.map(o=>Number(o.p));
    const since=Number(list[0].t);
    const spanDays=(now-since)/(24*60*60*1000);
    return {
      state:list.length<2 || spanDays<2 ? "building" : "ready",
      count:list.length,since,
      min:Math.min(...prices),max:Math.max(...prices),last:prices[prices.length-1]
    };
  }

  function formatShortDateEs(ms){
    const d=new Date(ms);
    if(!Number.isFinite(d.getTime())) return "";
    return english()?`${MONTHS_EN[d.getMonth()]} ${d.getDate()}`:`${d.getDate()} ${MONTHS_ES[d.getMonth()]}`;
  }

  function formatPriceHistory(summary){
    if(!summary || summary.state==="none" || !summary.count) return  tr("Sin registros todavía");
    const n=summary.count, since=formatShortDateEs(summary.since);
    const records=tr(n===1?"{n} registro desde el {since}":"{n} registros desde el {since}",{n,since});
    if(summary.state==="building") return tr("En construcción · {records} · se completa con cada visita",{records});
    if(summary.min===summary.max) return tr("Estable en {price} · {records}",{price:formatMoney(summary.min),records});
    return tr("Mín. {min} · Máx. {max} · {records}",{min:formatMoney(summary.min),max:formatMoney(summary.max),records});
  }

  // Campaign Radar (Creator Connections). One Amazon campaign row → the numbers the
  // radar shows. Budgets may arrive as a number or as {amount}.
  const amountOf=v=>{ if(v&&typeof v==="object") v=v.amount??v.value; if(v==null||v==="") return null; const n=Number(v); return Number.isFinite(n)?n:null; };
  function toRadarRow(c){
    if(!c || typeof c!=="object" || c.campaignId==null || c.campaignId==="") return null;
    const num=v=>{ if(v==null||v==="") return null; const n=Number(v); return Number.isFinite(n)?n:null; };
    return {
      campaignId:String(c.campaignId), name:String(c.campaignName||""), brand:String(c.brandName||""),
      start:epochOrNull(c.startDateTimeInEpochMills),
      end:epochOrNull(c.actualEndDateTimeInEpochMills||c.scheduledEndDateTimeInEpochMills),
      accepted:num(c.numberOfCreatorsAccepted), required:num(c.numberOfCreatorsRequired), fullyClaimed:c.fullyClaimed==null?null:!!c.fullyClaimed,
      ratePercent:num(c.commissionPercentage), sample:c.providingSample==null?null:!!c.providingSample,
      budgetLeft:amountOf(c.remainingBudget), budgetTotal:amountOf(c.totalBudget), asins:asinList(c.campaignAsins)
    };
  }
  // Every campaign row inside a JSON reply Amazon sent to the page, wherever it sits.
  function extractRadarRows(json,limit=2000){
    const out=[], stack=[[json,0]];
    while(stack.length && out.length<limit){
      const [node,depth]=stack.pop();
      if(!node || typeof node!=="object" || depth>10) continue;
      if(Array.isArray(node)){ for(const item of node) stack.push([item,depth+1]); continue; }
      if(node.campaignId!=null && ("numberOfCreatorsRequired" in node || "fullyClaimed" in node)){
        const row=toRadarRow(node); if(row) out.push(row); continue;
      }
      for(const value of Object.values(node)) if(value && typeof value==="object") stack.push([value,depth+1]);
    }
    return out;
  }
  // Two replies about the same campaign: the newer one wins, but a field it does not
  // carry (null, or an empty ASIN list) never erases what was already known.
  function mergeRadarRow(known,next){
    if(!known) return next||null;
    if(!next) return known;
    const out={...known};
    for(const [k,v] of Object.entries(next)) if(v!=null && v!=="" && !(Array.isArray(v)&&!v.length)) out[k]=v;
    return out;
  }
  // Commission and budget as Amazon prints them on the campaign detail page
  // ("Tarifa por comisión 40%", "Presupuesto de campaña $50,000.00",
  // "Restante del presupuesto $50,000.00"); used when its replies lacked them.
  function radarFromDetailText(text){
    const t=String(text||"");
    const money=re=>{ const m=t.match(re); if(!m) return null; const n=Number(m[1].replace(/,/g,"")); return Number.isFinite(n)?n:null; };
    const rate=t.match(/(?:Tarifa por comisi[oó]n|Commission rate)\s*:?\s*(\d+(?:[.,]\d+)?)\s*%/i);
    return {
      ratePercent:rate?Number(rate[1].replace(",",".")):null,
      budgetTotal:money(/(?:Presupuesto de (?:la )?campa[nñ]a|Campaign budget)\s*:?\s*(?:US)?\$\s*([\d,]+(?:\.\d+)?)/i),
      budgetLeft:money(/(?:Restante del presupuesto|Presupuesto restante|Remaining budget)\s*:?\s*(?:US)?\$\s*([\d,]+(?:\.\d+)?)/i)
    };
  }
  // Short budget for the radar's narrow cells: "$5,000", "$950.50", "$250K", "$1.2M".
  function formatBudgetShort(value){
    const n=Number(value);
    if(value==null || value==="" || !Number.isFinite(n)) return "—";
    if(Math.abs(n)>=100000){
      const [div,suffix]=Math.abs(n)>=1e6?[1e6,"M"]:[1e3,"K"];
      return `$${String(Math.floor(n/div*10)/10).replace(/\.0$/,"")}${suffix}`;
    }
    // Whole dollars from $1,000 up, rounded down (never shows more budget than left).
    if(Number.isInteger(n) || Math.abs(n)>=1000) return "$"+Math.floor(n).toLocaleString("en-US");
    return "$"+n.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
  }
  // Brand names compared loosely: "ANNESBURG", "Annesburg " and "Annes-burg" match.
  const normalizeBrand=name=>String(name||"").normalize("NFKD").replace(/[̀-ͯ]/g,"").toLowerCase().replace(/[^\p{L}\p{N}]+/gu,"");


  // Which tab can open a chat: only Creator Connections pages draw Amazon's Messages
  // drawer. The tab of the last analysis comes first, but only if it is still there.
  // Labels Amazon shows in the Messages list that are not brand names, in Spanish and
  // English (seen on the real page 2026-11-09: "6 hours ago", "Yesterday", "2 days ago",
  // "11/03/2026"). A brand name never matches these whole-text patterns.
  const LIST_MARKERS=new Set(["mensajes","final de la lista","fin del historial de chat","enviar mensaje",
    "messages","end of list","end of chat history","send message"]);
  function isConversationListMarker(text){
    const t=String(text||"").trim();
    if(!t) return true;
    if(LIST_MARKERS.has(t.toLowerCase())) return true;
    if(/^(ahora|hoy|ayer|anteayer|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)$/i.test(t)) return true;
    if(/^(just now|today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(t)) return true;
    if(/^hace\s+(?:\d+|un|una)\s+(segundos?|minutos?|horas?|d[ií]as?|semanas?|mes|meses|a[nñ]os?)$/i.test(t)) return true;
    if(/^(?:\d+|an?)\s+(seconds?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s+ago$/i.test(t)) return true;
    if(/^\d{1,2}:\d{2}(?::\d{2})?\s*(AM|PM|a\.\s?m\.|p\.\s?m\.)?$/i.test(t)) return true;
    if(/^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}$/.test(t)) return true;
    return false;
  }
  function isCreatorConnectionsUrl(url){
    return /^https:\/\/affiliate-program\.amazon\.com\/p\/connect(?:[/?#]|$)/i.test(String(url||""));
  }
  function pickConversationTab(tabs,preferredTabId){
    const usable=(tabs||[]).filter(t=>t?.id&&isCreatorConnectionsUrl(t.url));
    return usable.find(t=>t.id===preferredTabId)||usable.find(t=>t.active)||usable[0]||null;
  }

  // Collaborations ← accepted campaigns (owner's request, 25.23.0). The list of
  // campaigns the creator joined (toJoinedCampaign) is matched to each brand in
  // Collaborations; each campaign becomes one link (one per product).
  const PENDING_CAMPAIGN_STATUSES=new Set(["PENDING_CREATOR_ACTION"]);
  // "✕ Cancelar análisis" (owner's request, 2026-11-10): the state to go back to,
  // from the snapshot the service worker took when the run started. Results and the
  // last summary come back as they were; a run that never had a finished state shows
  // "LISTO". Without a snapshot, the results are left as they are.
  const ANALYSIS_SNAPSHOT_KEYS=["acaResultados","acaResultadosUserId","acaHasAnalyzed","acaEstadoProceso","acaProcesadas","acaTotalEsperado","acaModoAnalisis","acaConversacionesDetectadas","acaSinCambios"];
  function cancelledAnalysisState(previous,nowIso){
    const p=previous&&typeof previous==="object"?previous:{};
    const state=String(p.acaEstadoProceso||"");
    const out={
      acaEstadoProceso:state&&!ACTIVE_ANALYSIS_STATES.includes(state)?state:"LISTO",
      acaHasAnalyzed:!!p.acaHasAnalyzed,
      acaProcesadas:Number(p.acaProcesadas)||0,
      acaTotalEsperado:Number(p.acaTotalEsperado)||0,
      acaConversacionesDetectadas:Number(p.acaConversacionesDetectadas)||0,
      acaSinCambios:Number(p.acaSinCambios)||0,
      acaError:null,acaUltimaMarca:"",acaAnalisisCanceladoAt:nowIso,acaUltimoGuardado:nowIso
    };
    if(p.acaModoAnalisis) out.acaModoAnalisis=p.acaModoAnalisis;
    if(p.acaResultados&&typeof p.acaResultados==="object") out.acaResultados=p.acaResultados;
    return out;
  }
  // On/off switches for what Mila.Desk draws on Amazon (Configuración → Funciones en
  // Amazon, owner's request 2026-11-10). Saved in this browser as milaFeatures; a
  // missing or unknown value means on. Turning one off removes the panel, never data.
  const FEATURE_SWITCHES=["savedMessages","chatCollab","chatListMark","radarCards","radarDetail","viManage","viStorefront","viProduct","salesButton","confirmFullAnalysis"];
  function normalizeFeatures(raw){
    const out={};
    for(const key of FEATURE_SWITCHES) out[key]=!(raw&&typeof raw==="object"&&raw[key]===false);
    return out;
  }
  // Cover of one of the creator's videos (Amazon's mediaCentralUrl), only from Amazon's
  // image server and resized to 320 px high ("._SY320_" is Amazon's own resize suffix).
  function videoCoverUrl(url){
    const m=String(url||"").match(/^https:\/\/m\.media-amazon\.com\/images\/I\/([A-Za-z0-9+%-]{6,60})(?:\._[A-Za-z0-9_,]+_)?\.(jpe?g|png|webp)$/i);
    return m?`https://m.media-amazon.com/images/I/${m[1]}._SY320_.${m[2].toLowerCase()}`:"";
  }
  // --- ⬇ Descargar mis videos (owner's request 2026-11-17) -------------------
  // Amazon keeps each published video as HLS (3-second .ts pieces) on m.media-amazon.com;
  // the storefront list names its playlist. Only those addresses are accepted.
  const VIDEO_HLS_RE=/^https:\/\/m\.media-amazon\.com\/images\/S\/vse-vms-transcoding-artifact-[a-z0-9-]{2,40}\/[0-9a-f-]{36}\/[\w.-]{1,80}\.m3u8$/;
  function videoHlsFromHtml(html){
    const m=String(html||"").replace(/&quot;/g,'"').match(/https:\/\/m\.media-amazon\.com\/images\/S\/vse-vms-transcoding-artifact-[^"'\s<>]{2,200}?\.m3u8/);
    return m&&VIDEO_HLS_RE.test(m[0])?m[0]:"";
  }
  // Products and video file of each video in a storefront page (getItems?viewScope=Video),
  // added into byAci ({aci:{asins,hls}}). A video can appear in more than one block or page
  // (student's report 2026-11-18: a video with a product showed «Sin productos etiquetados»),
  // so later blocks add to what was found instead of replacing it.
  function storefrontVideoItems(html,byAci){
    const out=byAci||{};
    for(const block of String(html||"").split(/(?=<div[^>]+data-aci="amzn1\.vse\.video\.)/i)){
      const aci=(block.match(/data-aci="(amzn1\.vse\.video\.[a-f0-9]{32})"/i)||[])[1];
      if(!aci) continue;
      const prev=out[aci]||{asins:[],hls:""};
      out[aci]={asins:[...new Set([...prev.asins,...[...block.matchAll(/amzn1\.asin\.([A-Z0-9]{10})/g)].map(m=>m[1])])],hls:prev.hls||videoHlsFromHtml(block)};
    }
    return out;
  }
  // The best picture in a master playlist (largest resolution, then bandwidth), as a full
  // address in the same folder; "" when there is none.
  function hlsBestVariant(master,masterUrl){
    const lines=String(master||"").split(/\r?\n/).map(l=>l.trim());
    let best=null;
    for(let i=0;i<lines.length;i++){
      if(!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
      const uri=lines[i+1]||"", res=(lines[i].match(/RESOLUTION=(\d+)x(\d+)/)||[]), bw=Number((lines[i].match(/[^-]BANDWIDTH=(\d+)/)||[])[1]||0);
      const px=(Number(res[1])||0)*(Number(res[2])||0);
      if(!/^[\w.-]{1,80}\.m3u8$/.test(uri)) continue;
      if(!best||px>best.px||(px===best.px&&bw>best.bw)) best={uri,px,bw};
    }
    return best?hlsSibling(masterUrl,best.uri):"";
  }
  // The .ts pieces of a media playlist, in order, as full addresses in the same folder.
  function hlsSegments(playlist,playlistUrl){
    return String(playlist||"").split(/\r?\n/).map(l=>l.trim()).filter(l=>l&&!l.startsWith("#")).filter(l=>/^[\w.-]{1,80}\.ts$/.test(l)).map(l=>hlsSibling(playlistUrl,l));
  }
  function hlsSibling(url,name){ const u=String(url||""); return VIDEO_HLS_RE.test(u)||/^https:\/\/m\.media-amazon\.com\/images\/S\/vse-vms-transcoding-artifact-/.test(u)?u.slice(0,u.lastIndexOf("/")+1)+name:""; }
  // A safe file name from the video's title.
  function videoFileName(title,aci){
    const base=String(title||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^\w -]+/g," ").replace(/\s+/g," ").trim().slice(0,60).trim();
    return (base||"video-"+String(aci||"").slice(-8))+".mp4";
  }
  // --- 🩺 Hospital de videos (owner's request 2026-11-16) ---------------------
  // Mila.Desk's own rules. Signals: status, placement on each tagged product, cover
  // (pixels), title and how long people watch. Thresholds are estimates, not Amazon rules.
  // Color: red = Amazon isn't showing it; yellow = it shows, something to fix; green = fine.
  const HEALTH_BANNED=/(\$\s?\d|\d+\s?%\s?(?:off|de descuento)|\bdeals?\b|\bsale\b|\bcoupons?\b|\bdiscount|\bpromo|\bcode\b|\bblack friday|\bprime day|\bcyber monday|\bcheap|\bfree shipping|\bofertas?\b|\bdescuento|\bcup[oó]n|\brebaja|\bbarat[oa]s?\b|\benv[ií]o gratis|\bprecio)/i;
  const HEALTH_STOP=new Set("the and for with from your this that are its new set pack pcs piece pieces inch inches size color black white los las del una unos unas para con por que mas muy este esta mi tu su".split(" "));
  const healthWords=s=>String(s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").split(/[^a-z0-9]+/).filter(w=>w.length>2&&!HEALTH_STOP.has(w)&&!/^\d+$/.test(w));
  function videoDurationSecs(d){
    if(d==null||d==="") return null;
    if(typeof d==="number") return d>0?d:null;
    const p=String(d).split(":").map(Number);
    if(p.some(n=>!Number.isFinite(n))) return null;
    return p.reduce((a,b)=>a*60+b,0)||null;
  }
  // Cover numbers from RGBA pixels (already scaled down): brightness, contrast, color,
  // sharpness (variance of the Laplacian: blurry images have few fine edges), black bars.
  function videoCoverStats(px,w,h){
    const n=w*h;
    if(!n||!px||px.length<n*4) return null;
    const g=new Float32Array(n); let s=0,s2=0,sat=0;
    for(let i=0,j=0;j<n;i+=4,j++){
      const r=px[i],gr=px[i+1],b=px[i+2], L=0.299*r+0.587*gr+0.114*b;
      g[j]=L; s+=L; s2+=L*L;
      const mx=Math.max(r,gr,b); sat+=mx?(mx-Math.min(r,gr,b))/mx:0;
    }
    const mean=s/n;
    let ls=0,ls2=0,lc=0;
    for(let y=1;y<h-1;y++) for(let x=1;x<w-1;x++){ const k=y*w+x, v=4*g[k]-g[k-1]-g[k+1]-g[k-w]-g[k+w]; ls+=v; ls2+=v*v; lc++; }
    const flatDark=(x0,x1,y0,y1)=>{ let a=0,a2=0,c=0; for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++){ const v=g[y*w+x]; a+=v; a2+=v*v; c++; } const m=a/c; return c>0&&m<25&&Math.sqrt(Math.max(0,a2/c-m*m))<6; };
    const eh=Math.max(2,Math.round(h*.08)), ew=Math.max(2,Math.round(w*.08));
    return { ratio:w/h, lum:Math.round(mean), contrast:Math.round(Math.sqrt(Math.max(0,s2/n-mean*mean))), sat:Math.round(100*sat/n),
      sharp:lc?Math.round(ls2/lc-(ls/lc)**2):0,
      bars:(flatDark(0,w,0,eh)&&flatDark(0,w,h-eh,h))||(flatDark(0,ew,0,h)&&flatDark(w-ew,w,0,h)) };
  }
  // video: one row of the hospital list; placements: asin → placement (undefined = not checked
  // yet, null = could not check); cover: videoCoverStats(), {pending:true} or {error}.
  // Owner's rules (2026-11-22): a video works when it shows on the product page, in the gallery
  // above or the carousel below (many products have only the carousel). Its place in the list
  // rotates, so it does not count. Red is a video Amazon does not show anywhere. The only fix a
  // creator can make without uploading again is a new title or cover (confirmed by the owner),
  // so that is the advice; generic advice on the title, cover or start was removed.
  // cover is accepted for older callers and not used.
  function videoHealth({video={},placements={},cover=null,now=Date.now()}={}){
    const items=[]; let red=false, waiting=false;
    const add=(area,level,text)=>items.push({area,level,text});
    const age=Number(video.created)>0?Math.max(0,Math.floor((now-Number(video.created))/864e5)):null;
    const state=String(video.state||"").toUpperCase();
    const FIX=tr("Cambia la portada o el título: es lo que puedes cambiar en Amazon sin volver a subir el video, y Amazon vuelve a mostrarlo si mejora.");
    if(state&&state!=="LIVE"){
      red=true;
      const why=(video.rejection||[]).join(", ");
      add("Estado","grave",why?tr("Amazon no lo tiene publicado (estado: {state}). Motivo: {why}.",{state,why}):tr("Amazon no lo tiene publicado (estado: {state}).",{state}));
    }
    if(video.improveReach) add("Estado","leve",tr("Amazon le puso la marca «Mejorar alcance».")+" "+FIX);
    const title=String(video.title||"").trim(), banned=title.match(HEALTH_BANNED);
    if(banned) add("Título","leve",tr("El título dice «{word}»: Amazon no permite precios, ofertas, códigos ni promociones en el título; el video puede ser rechazado o quedar escondido.",{word:banned[0].trim()}));

    const asins=video.asins||[];
    if(!asins.length){ red=true; add("Ubicación","grave",tr("No tiene productos etiquetados: no puede salir en ninguna página de producto.")); }
    let placed=0, checked=0; const missing=[];
    for(const asin of asins){
      const p=placements[asin];
      if(p===undefined){ waiting=true; continue; }
      if(!p) continue;
      const who=asins.length>1?asin+": ":"";
      if(p.change) add("Título","nota",who+p.change);
      if(p.listed===false){ add("Ubicación","leve",tr("{who}Amazon no encontró la página de este producto.",{who})); continue; }
      if(p.topIndex||p.carouselIndex){
        placed++; checked++;
        const st=p.presence;
        if(st&&(st.level==="weak"||st.level==="intermittent")) add("Ubicación","leve",who+presenceText(st)+" "+tr("Un título o una portada mejores pueden ayudar a que salga más seguido."));
        const extra=(st&&(st.level==="strong"||st.level==="few")?" "+presenceText(st):"");
        add("Ubicación","bien",(p.topIndex&&p.carouselIndex?tr("{who}Se muestra en la galería de arriba y en el carrusel.",{who})
          :p.topIndex?tr("{who}Se muestra en la galería de arriba.",{who}):tr("{who}Se muestra en el carrusel de videos.",{who}))+extra);
      } else if(p.position==="NEITHER"){ checked++; missing.push({asin,total:Number(p.carouselTotal)||0}); }
    }
    if(missing.length){
      const where=asins.length>1?tr("en {m} de {n} productos",{m:missing.length,n:asins.length}):tr("en la página del producto");
      if(age!=null&&age<7) add("Ubicación","leve",tr("Todavía no sale {where}: tiene {d} días y Amazon suele tardar unos días.",{where,d:age}));
      else {
        if(!placed) red=true;
        let text=tr("No se muestra {where}, ni en la galería ni en el carrusel.",{where});
        if(missing.every(m=>m.total>=10)) text+=" "+tr("Ese producto ya tiene 10 o más videos.");
        add("Ubicación",placed?"leve":"grave",text+" "+FIX);
      }
    }
    // Amazon's numbers, as facts.
    const views=video.views==null?null:Number(video.views);
    const pct=video.pctViewed==null||!Number.isFinite(Number(video.pctViewed))?null:Number(video.pctViewed);
    if(views!=null&&Number.isFinite(views)) add("Vistas","nota",pct!=null?tr("{views} vistas · en promedio ven el {pct} %.",{views,pct:Math.round(pct)}):tr("{views} vistas.",{views}));

    const count=l=>items.filter(i=>i.level===l).length;
    const color=red?"red":count("grave")||count("leve")?"yellow":"green";
    const share=checked?placed/checked:1;
    const score=color==="red"?Math.round(39*share):color==="yellow"?Math.round(40+44*share):100;
    const ORDER={grave:0,leve:1,nota:2,bien:3};
    items.sort((a,b)=>ORDER[a.level]-ORDER[b.level]);
    return {color,score,items,waiting};
  }
  function acceptedCampaignUrl(c){
    if(!c?.campaignId) return "";
    const params=[["campaignId",c.campaignId],["adId",c.adId],["creatorId",c.creatorId]]
      .filter(([,v])=>v).map(([k,v])=>`${k}=${encodeURIComponent(String(v))}`);
    return "https://affiliate-program.amazon.com/p/connect/request?"+params.join("&");
  }
  function campaignIdFromUrl(url){
    const m=String(url||"").match(/^https:\/\/[^?#]+\?(?:[^#]*&)?campaignId=([^&#]+)/);
    if(!m) return "";
    try{ return decodeURIComponent(m[1]); }catch{ return ""; }
  }
  // Same brand when the normalized names are equal, or one starts with the other
  // ("Kinglucky" ↔ "KINGLUCKY Official") and the shorter one has 4+ characters.
  function sameBrand(a,b){
    const x=normalizeBrand(a), y=normalizeBrand(b);
    if(!x||!y) return false;
    if(x===y) return true;
    const [short,long]=x.length<=y.length?[x,y]:[y,x];
    return short.length>=4 && long.startsWith(short);
  }
  function acceptedCampaignsForBrand(brand,ads){
    return (ads||[]).filter(ad=>ad?.campaignId && !PENDING_CAMPAIGN_STATUSES.has(ad.status) && sameBrand(brand,ad.brand));
  }
  const campaignLabel=ad=>String(ad?.name||"").replace(/\s+/g," ").trim().slice(0,80)||"Campaña";
  // Adds the brand's accepted campaigns that are not linked yet and that the user
  // did not remove before. Returns the new list and the campaign ids added.
  function mergeAcceptedCampaigns(existing,ads,dismissedIds,now=new Date().toISOString()){
    const list=Array.isArray(existing)?existing.slice():[];
    const linked=new Set(list.map(c=>campaignIdFromUrl(c?.url)).filter(Boolean));
    const dismissed=new Set((dismissedIds||[]).map(String));
    const added=[];
    for(const ad of ads||[]){
      const id=String(ad.campaignId);
      if(linked.has(id)||dismissed.has(id)) continue;
      // Default name «Campaña N»; the user can rename it (owner's decision, 25.23.1).
      list.push({url:acceptedCampaignUrl(ad),name:`Campaña ${list.length+1}`,createdAt:now});
      linked.add(id); added.push(id);
    }
    return {campaigns:list,added};
  }
  // Accepted campaigns not linked to any collaboration (for the manual picker).
  function unlinkedAcceptedCampaigns(collaborations,ads){
    const linked=new Set();
    for(const item of Object.values(collaborations||{})) for(const c of item?.campaigns||[]){ const id=campaignIdFromUrl(c?.url); if(id) linked.add(id); }
    return (ads||[]).filter(ad=>ad?.campaignId && !PENDING_CAMPAIGN_STATUSES.has(ad.status) && !linked.has(String(ad.campaignId)));
  }
  // Free Samples brands approved in Mila.Desk → a fast lookup by normalized name.
  function freeSampleBrandSet(rows){
    const set=new Set();
    for(const row of rows||[]){ const key=normalizeBrand(row?.brand_name); if(key) set.add(key); }
    return set;
  }
  // Free Samples: the Creator Connections search for a brand's campaigns. Built from
  // the brand name (no creatorId), so it opens with each user's own Amazon session.
  function freeSampleCampaignUrl(brand){
    const name=String(brand||"").trim().replace(/\s+/g," ");
    if(!name) return "";
    return `https://affiliate-program.amazon.com/p/connect/requests?status=opportunity&type=affiliate-plus&sortBy=commission_rate&keyword=${encodeURIComponent(name)}`;
  }
  // Amazon's Creator Connections categories (/connect/api/categories, read on
  // 2026-11-05). A number Amazon adds later is ignored until it is listed here.
  const SAMPLE_CATEGORIES=[
    [2335752011,"Celulares y Accesorios"],[16310101,"Comida Gourmet y Alimentos"],[16310091,"Industrial y Científico"],[3760911,"Belleza y Cuidado Personal"],
    [3760901,"Salud y Hogar"],[8098158011,"Servicios de Amazon para Hogar y Negocios"],[3375251,"Deportes y Actividades al Aire Libre"],[18981045011,"Amazon Luxury"],
    [10272111,"Todo lo demás"],[11091801,"Instrumentos Musicales"],[11260432011,"Productos Handmade"],[2350149011,"Apps y Juegos"],
    [13727921011,"Alexa Skills"],[5174,"CDs y Vinilo"],[172282,"Electrónica"],[4991425011,"Arte Coleccionable y Bellas Artes"],
    [468642,"Videojuegos"],[100235949011,"Códigos Digitales, Tokens y Vales"],[3561432011,"Tarjetas de Crédito y de Pago"],[599858,"Suscripciones a Revistas"],
    [10677469011,"Amazon Autos"],[2972638011,"Patio, Césped y Jardín"],[15684181,"Automotriz"],[133140011,"Tienda Kindle"],
    [2617941011,"Arte y Manualidades"],[18145289011,"Libros Audibles y Originales"],[16333372011,"Dispositivos Amazon y Accesorios"],[1055398,"Hogar y Cocina"],
    [1064954,"Productos de Oficina"],[2238192011,"Tarjetas Regalos"],[165793011,"Juguetes y Juegos"],[165796011,"Bebés"],
    [228013,"Herramientas y Mejoras del Hogar"],[229534,"Software"],[163856011,"Música Digital"],[283155,"Libros"],
    [2619525011,"Electrodomésticos"],[2619533011,"Productos para Animales"],[7141123011,"Ropa, Zapatos y Joyería"],[2625373011,"Películas y TV"]
  ].map(([id,name])=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name,"es"));
  const sampleCategoryName=new Map(SAMPLE_CATEGORIES.map(c=>[c.id,c.name]));
  // Known categories in a list of numbers, once each, in alphabetical order.
  function knownSampleCategories(nodes){
    const wanted=new Set((Array.isArray(nodes)?nodes:[]).map(Number));
    return SAMPLE_CATEGORIES.filter(c=>wanted.has(c.id)).map(c=>c.id);
  }
  // The categories of one brand: its campaigns only, since Amazon's search also
  // returns brands whose name merely contains the words.
  function brandCategoryNodes(rows,brand){
    const key=normalizeBrand(brand);
    if(!key) return [];
    return knownSampleCategories((rows||[]).filter(c=>normalizeBrand(c?.brandName)===key).flatMap(c=>Array.isArray(c?.campaignBrowseNodes)?c.campaignBrowseNodes:[]));
  }
  function sampleCategoryNames(nodes){ return knownSampleCategories(nodes).map(id=>tr(sampleCategoryName.get(id))); }
  // Choices for the filter: only categories that have brands, plus how many have none.
  function sampleCategoryOptions(items){
    const counts=new Map(); let none=0;
    for(const item of items||[]){
      const known=knownSampleCategories(item?.categories);
      if(!known.length) none++;
      for(const id of known) counts.set(id,(counts.get(id)||0)+1);
    }
    return {options:SAMPLE_CATEGORIES.filter(c=>counts.has(c.id)).map(c=>({id:c.id,name:tr(c.name),count:counts.get(c.id)})),none};
  }
  // value: "" all brands, "none" brands without a category, otherwise a category number.
  function matchesSampleCategory(item,value){
    if(!value) return true;
    const known=knownSampleCategories(item?.categories);
    return value==="none"?!known.length:known.includes(Number(value));
  }
  // Brand names for the suggestion list: one spelling per brand, alphabetical.
  function uniqueBrandNames(names){
    const seen=new Map();
    for(const raw of names||[]){
      const name=String(raw||"").trim().replace(/\s+/g," ");
      const key=normalizeBrand(name);
      if(key && name.length<=100 && !seen.has(key)) seen.set(key,name);
    }
    return [...seen.values()].sort((a,b)=>a.localeCompare(b,"es",{sensitivity:"base"}));
  }
  // Is this brand already verified, or already sent by this user and waiting?
  function freeSampleDuplicate(brand,approvedRows,ownRows){
    const key=normalizeBrand(brand);
    if(!key) return null;
    const same=row=>normalizeBrand(row?.brand_name)===key;
    if((approvedRows||[]).some(same)) return "approved";
    if((ownRows||[]).some(row=>same(row)&&row?.status==="pending")) return "pending";
    return null;
  }
  // Where a conversation should sit in Amazon's Messages list, which is ordered by
  // latest message: its rank among the analyzed conversations by last activity.
  function conversationPositionHint(results,conversationKey,name){
    const dated=Object.entries(results||{}).filter(([,r])=>Number.isFinite(Date.parse(r?.fechaActividad)))
      .sort((a,b)=>Date.parse(b[1].fechaActividad)-Date.parse(a[1].fechaActividad));
    let index=conversationKey?dated.findIndex(([key])=>key===conversationKey):-1;
    if(index<0 && name) index=dated.findIndex(([,r])=>String(r?.marca||"")===String(name));
    return index>=0?{index,total:dated.length}:null;
  }
  const radarKey=(...parts)=>parts.map(p=>String(p??"").trim().toLowerCase()).join("|");
  // How urgent joining is. "last": ≥80 % of creator spots taken, ≤3 days left or
  // ≤10 % of the budget left; "filling": ≥50 %, ≤7 days or ≤30 %.
  const RADAR_LABELS={closed:"Cerrada",last:"Última oportunidad",filling:"Se está llenando",open:"Con cupo"};
  function radarStatus(row,now=Date.now()){
    const required=row?.required>0?row.required:null;
    const accepted=row?.accepted!=null?Math.max(0,row.accepted):null;
    const fill=required&&accepted!=null?Math.min(1,accepted/required):null;
    const remaining=required&&accepted!=null?Math.max(0,required-accepted):null;
    const daysLeft=row?.end?Math.ceil((row.end-now)/86400000):null;
    const budgetPct=row?.budgetTotal>0&&row.budgetLeft!=null?Math.max(0,Math.min(1,row.budgetLeft/row.budgetTotal)):null;
    const reasons=[];
    let level="open";
    if(row?.fullyClaimed || remaining===0 || (row?.end && row.end<now) || budgetPct===0){
      level="closed";
      reasons.push(row?.end && row.end<now?tr("la campaña terminó"):budgetPct===0?tr("sin presupuesto"):tr("cupo completo"));
    }else{
      if(fill!=null && fill>=0.8) reasons.push(tr("{n} % del cupo ocupado",{n:Math.round(fill*100)}));
      if(daysLeft!=null && daysLeft<=3) reasons.push(tr(daysLeft===1?"cierra en {n} día":"cierra en {n} días",{n:daysLeft}));
      if(budgetPct!=null && budgetPct<=0.1) reasons.push(tr("queda poco presupuesto"));
      if(reasons.length) level="last";
      else if((fill!=null&&fill>=0.5)||(daysLeft!=null&&daysLeft<=7)||(budgetPct!=null&&budgetPct<=0.3)) level="filling";
    }
    return {level,label:tr(RADAR_LABELS[level]),fill,remaining,accepted,required,daysLeft,budgetPct,reasons};
  }


  // Saved chat messages ("Mensajes predeterminados"). They live only in the
  // browser (chrome.storage.local) and are only ever sent after the user clicks.
  const SAVED_MESSAGE_LIMITS={items:20,name:30,text:5000,amazonChars:1000};
  // Only the address can go one line per message (owner's decision, 25.18.1).
  const ADDRESS_MESSAGE_ID="direccion";
  function defaultSavedMessages(){
    return [
      {id:"principal",name:"Mensaje principal",text:"",mode:"insert",splitLines:false},
      {id:"direccion",name:"Dirección",text:"",mode:"send",splitLines:true}
    ];
  }
  function normalizeSavedMessages(list){
    if(!Array.isArray(list)) return defaultSavedMessages();
    const out=[], seen=new Set();
    for(const raw of list){
      if(!raw||typeof raw!=="object") continue;
      let id=String(raw.id||"").replace(/[^A-Za-z0-9_-]/g,"").slice(0,40);
      if(!id||seen.has(id)) id="m"+(out.length+1)+"_"+seen.size;
      seen.add(id);
      out.push({
        id,
        name:String(raw.name||"").replace(/\s+/g," ").trim().slice(0,SAVED_MESSAGE_LIMITS.name),
        text:String(raw.text||"").replace(/\r\n?/g,"\n").slice(0,SAVED_MESSAGE_LIMITS.text),
        mode:raw.mode==="send"?"send":"insert",
        splitLines:id===ADDRESS_MESSAGE_ID&&!!raw.splitLines
      });
      if(out.length>=SAVED_MESSAGE_LIMITS.items) break;
    }
    return out;
  }
  // "{marca}" (or "{brand}") becomes the name of the brand whose chat is open.
  function fillMessageTemplate(text, brand){
    return String(text||"").replace(/\{\s*(marca|brand)\s*\}/gi,String(brand||"").trim());
  }
  // The texts to send for one saved message: one per non-empty line when
  // splitLines is on (Amazon joins line breaks into one paragraph), else one.
  function savedMessageParts(message, brand){
    const text=fillMessageTemplate(message?.text,brand);
    const parts=message?.splitLines
      ? text.split("\n").map(line=>line.replace(/\s+/g," ").trim()).filter(Boolean)
      : [text.trim()].filter(Boolean);
    return parts;
  }
  // Parts longer than Amazon's limit (1-based positions), so nothing is cut off.
  function tooLongParts(parts){
    return (parts||[]).map((p,i)=>String(p).length>SAVED_MESSAGE_LIMITS.amazonChars?i+1:0).filter(Boolean);
  }

  // 📨 Mensajes a marcas (mensajes.html, owner's request 2026-11-12). Brands come from
  // Creator Connections' open campaigns; each message is sent only after the creator
  // reviews the list and clicks. The template and the history stay in this browser.
  const OUTREACH_LIMITS={blocks:4,blockChars:1000,history:5000};
  // One row per brand from campaign/search rows: its best open campaign (not full, not
  // joined), by commission, plus how many open campaigns it has.
  function outreachBrandRows(rows,joinedIds=new Set()){
    const byBrand=new Map();
    for(const c of rows||[]){
      const brand=String(c?.brandName||"").trim(), key=normalizeBrand(brand), id=String(c?.campaignId||"");
      if(!key || !/^[A-Za-z0-9._:-]{1,80}$/.test(id) || joinedIds.has(id)) continue;
      const accepted=Number(c.numberOfCreatorsAccepted), required=Number(c.numberOfCreatorsRequired);
      if(c.fullyClaimed || (required>0 && accepted>=required)) continue;
      const row={brand:brand.slice(0,100),brandKey:key,campaignId:id,campaignName:String(c.campaignName||"").slice(0,200),
        asin:asinList(c.campaignAsins)[0]||"",ratePercent:Number(c.commissionPercentage)||0,
        end:epochOrNull(c.actualEndDateTimeInEpochMills||c.scheduledEndDateTimeInEpochMills),
        providingSample:!!c.providingSample,campaigns:1};
      const prev=byBrand.get(key);
      if(!prev) byBrand.set(key,row);
      else byBrand.set(key,{...(row.ratePercent>prev.ratePercent?row:prev),campaigns:prev.campaigns+1});
    }
    return [...byBrand.values()];
  }
  // 🖼️ Product photo and title for each brand in Mensajes a marcas (owner's request 2026-11-26).
  // Same request Amazon's own opportunities page sends to /connect/api/collaboration/asin/info,
  // seen read-only on 2026-11-26: {asinsByMarketplaceId:{<marketplace>:[asins]}, storeId, locale}.
  // 114 ASINs answered in one call. The answer is responses[0].asinToAsinInfoMap[asin].
  function asinInfoBody(asins,marketplaceId,storeId,locale){
    const list=[...new Set((asins||[]).filter(a=>/^[A-Z0-9]{10}$/.test(String(a))))].slice(0,150);
    const market=/^[A-Z0-9]{5,20}$/.test(String(marketplaceId||""))?String(marketplaceId):"ATVPDKIKX0DER";
    return list.length&&storeId?{asinsByMarketplaceId:{[market]:list},storeId:String(storeId),locale:locale==="en_US"?"en_US":"es_US"}:null;
  }
  // Amazon's answer is untrusted: only a plain image id becomes a URL on Amazon's image host.
  function asinInfoProducts(raw){
    const map=raw?.responses?.[0]?.asinToAsinInfoMap, out={};
    if(!map||typeof map!=="object") return out;
    for(const [asin,info] of Object.entries(map)){
      if(!/^[A-Z0-9]{10}$/.test(asin)) continue;
      const id=String(info?.asinImage?.physicalId||""), ext=String(info?.asinImage?.extension||"jpg").toLowerCase();
      out[asin]={
        image:/^[A-Za-z0-9+%_-]{5,60}$/.test(id)&&/^(jpg|jpeg|png|webp)$/.test(ext)?`https://m.media-amazon.com/images/I/${id}._SL200_.${ext}`:"",
        title:String(info?.title||"").replace(/[\u0000-\u001f]/g,"").trim().slice(0,200)
      };
    }
    return out;
  }
  // 📌 Pinterest (owner's request 2026-11-26). The pin's link is the creator's own affiliate
  // link: the product with her store tag (her Associates store id, e.g. «name-20»).
  function affiliateLink(asin,tag){
    if(!/^[A-Z0-9]{10}$/.test(String(asin||""))) return "";
    return `https://www.amazon.com/dp/${asin}`+(/^[A-Za-z0-9][A-Za-z0-9-]{1,40}-2\d$/.test(String(tag||""))?`?tag=${tag}`:"");
  }
  // The product of a pin made from the creator's own video: an ASIN or an Amazon product link.
  function asinFromText(text){
    const s=String(text||"").trim();
    if(/^[A-Z0-9]{10}$/i.test(s)) return s.toUpperCase();
    const m=s.match(/^https?:\/\/(?:www\.|smile\.)?amazon\.com\/(?:[^?#]*\/)?(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?#]|$)/i);
    return m?m[1].toUpperCase():"";
  }
  // A product title as people say it: up to the first «,», «|», « - », «(»… and at most max letters.
  function shortProductName(title,max=60){
    let s=String(title||"").replace(/\s+/g," ").trim().split(/\s*(?:[,|(\[]|\s[-–—:]\s)\s*/)[0].trim();
    if(s.length>max){ s=s.slice(0,max+1); s=s.slice(0,Math.max(s.lastIndexOf(" "),Math.floor(max*.6))).trim(); }
    return s;
  }
  // Title (Pinterest: 100), the big words on the image and the description (Pinterest: 500)
  // with the disclosure Amazon asks of its associates. mode "video" talks about the video.
  // variant 0-2: other words for another pin of the same product (Pinterest favors fresh pins).
  function pinTexts({product="",brand="",lang="es",mode="image",variant=0}={}){
    const name=shortProductName(product)||String(brand||"").trim()||(lang==="en"?"Amazon find":"Hallazgo de Amazon");
    const b=String(brand||"").replace(/\s+/g," ").trim().slice(0,40);
    const withBrand=b&&!name.toLowerCase().includes(b.toLowerCase())?(lang==="en"?`${name} by ${b}`:`${name} de ${b}`):name;
    const tag=b.replace(/[^A-Za-z0-9]/g,"");
    const tags=(lang==="en"?["#amazonfinds","#amazonmusthaves","#founditonamazon"]:["#amazonfinds","#hallazgosdeamazon","#amazonmusthaves"])
      .concat(tag.length>=3&&tag.length<=30?["#"+tag.toLowerCase()]:[]);
    const call=lang==="en"
      ?(mode==="video"?"Watch the video and tap the pin to see it on Amazon. 🛒":"Tap the pin to see it on Amazon. 🛒")
      :(mode==="video"?"Mira el video y toca el pin para verlo en Amazon. 🛒":"Toca el pin para verlo en Amazon. 🛒");
    const disclosure=lang==="en"?"As an Amazon Associate I earn from qualifying purchases.":"Como afiliada de Amazon, gano con las compras que califican.";
    const v=((Number(variant)||0)%3+3)%3, en=lang==="en";
    const title=[withBrand, en?`${withBrand}: my Amazon find`:`${withBrand}: mi hallazgo de Amazon`, en?`Worth it: ${withBrand}`:`Vale la pena: ${withBrand}`][v];
    const headline=[shortProductName(name,34), en?"My Amazon find":"Mi hallazgo de Amazon", en?"Have you seen this?":"¿Ya lo conocías?"][v];
    const opener=["", en?"I found it on Amazon. ":"Lo encontré en Amazon. ", en?"Worth a look. ":"Vale la pena verlo. "][v];
    return {
      title:title.slice(0,100),
      headline,
      description:`${opener}${withBrand}. ${call}\n\n${tags.join(" ")}\n\n${disclosure}`.slice(0,500),
      // Pinterest's alt text: what the picture is, for screen readers and search.
      alt:(mode==="video"?(en?`Video about ${withBrand}`:`Video sobre ${withBrand}`):(en?`Picture of ${withBrand}`:`Imagen de ${withBrand}`)).slice(0,500)
    };
  }
  // What the creator already has with a brand, most important first: a collaboration, a
  // reply, a message sent from this page, a message of theirs in the analysis, or nothing.
  // Only "new" brands are ticked by default.
  function outreachLabel(brandKey,{history,analysis,collabs}={}){
    if(collabs?.has?.(brandKey)) return {kind:"collab",stage:collabs.get(brandKey)||""};
    const seen=analysis?.get?.(brandKey);
    if(seen?.replied) return {kind:"replied"};
    const sent=history?.[brandKey];
    if(sent?.at) return {kind:"sent",at:sent.at};
    if(seen?.wrote) return {kind:"wrote"};
    return {kind:"new"};
  }
  // Brands from the analysis results (acaResultados): replied = the brand wrote at least
  // once; wrote = only the creator did.
  function outreachAnalysisMap(results){
    const out=new Map();
    for(const r of Object.values(results||{})){
      const key=normalizeBrand(r?.marca); if(!key) continue;
      const prev=out.get(key)||{replied:false,wrote:false};
      out.set(key,{replied:prev.replied||Number(r.mensajesMarca)>0,wrote:prev.wrote||Number(r.mensajesMios)>0});
    }
    return out;
  }
  // The messages for one brand: each non-empty block is one Amazon message (Amazon joins
  // line breaks), with {marca}, {campaña}, {asin}, {enlace} and {comision} filled in.
  function outreachParts(blocks,row){
    const vars={marca:row?.brand,brand:row?.brand,"campaña":row?.campaignName,campana:row?.campaignName,campaign:row?.campaignName,
      asin:row?.asin,enlace:row?.asin?`https://www.amazon.com/dp/${row.asin}`:"",link:row?.asin?`https://www.amazon.com/dp/${row.asin}`:"",
      comision:row?.ratePercent?`${Number(row.ratePercent).toFixed(0)} %`:"",commission:row?.ratePercent?`${Number(row.ratePercent).toFixed(0)} %`:"",
      producto:row?.campaignName,product:row?.campaignName,video:row?.videoUrl};
    return (Array.isArray(blocks)?blocks:[])
      .map(b=>String(b||"").replace(/\{\s*([\wñ]+)\s*\}/gi,(m,k)=>{ const v=vars[k.toLowerCase()]; return v==null?m:String(v).trim(); }).replace(/\s+/g," ").trim())
      .filter(Boolean).slice(0,OUTREACH_LIMITS.blocks);
  }
  // 📤 Send a video to accepted campaigns (owner's request 2026-11-13). Amazon takes the
  // video's link (collaboration/creator/content/add, seen in Amazon's page code); the link is
  // the storefront video page the a.co share link opens. Only amazon.com storefront videos.
  function storefrontVideoUrl(handle,aci){
    return /^[A-Za-z0-9._-]{1,80}$/.test(String(handle||""))&&/^amzn1\.vse\.video\.[a-f0-9]{32}$/i.test(String(aci||""))
      ?`https://www.amazon.com/shop/${handle}/video/${aci}`:"";
  }
  // Amazon's own edit page for one video (seen 2026-11-27: «Administrar» opens /creatorhub/video/<hex>).
  function creatorEditUrl(aci){
    const hex=(String(aci||"").match(/^amzn1\.vse\.video\.([a-f0-9]{32})$/i)||[])[1];
    return hex?`https://www.amazon.com/creatorhub/video/${hex.toLowerCase()}`:"";
  }
  const isStorefrontVideoUrl=url=>/^https:\/\/www\.amazon\.com\/shop\/[A-Za-z0-9._-]{1,80}\/video\/amzn1\.vse\.video\.[a-f0-9]{32}$/i.test(String(url||""));
  // Accepted campaigns with no content yet that one of the creator's videos (newest first)
  // shows the product of (the campaign's ASINs include its variants). Campaigns sent from
  // here (sent: {campaignId: {at}}) stay in the list as sent, never to be sent again.
  function videoSubmissions({videos=[],joined=[],handle="",sent={},now=Date.now()}={}){
    const out=[];
    for(const c of joined||[]){
      const id=String(c?.campaignId||"");
      const done=!!sent?.[id];
      if(!id||!c.adId||(!done&&(c.contentCount!==0||(c.end&&c.end<=now)))) continue;
      const asins=new Set(c.asins||[]);
      const video=(videos||[]).find(v=>(v?.asins||[]).some(a=>asins.has(a)));
      const videoUrl=video&&storefrontVideoUrl(handle,video.aci);
      if(!done&&!videoUrl) continue;
      out.push({campaignId:id,adId:String(c.adId),brand:c.brand||"",campaignName:c.name||"",ratePercent:c.ratePercent||0,end:c.end||null,
        asin:(video?.asins||[]).find(a=>asins.has(a))||(c.asins||[])[0]||"",videoTitle:video?.title||"",
        videoUrl:done?String(sent[id].url||videoUrl||""):videoUrl,sent:done,sentAt:done?Number(sent[id].at)||null:null});
    }
    return out.sort((a,b)=>a.sent-b.sent||(a.end||Infinity)-(b.end||Infinity));
  }
  // Amazon's answer to chat/message/send ({status, messageId}, read in Amazon's page code on
  // 2026-11-12): anything but SUCCESS means Amazon held the message.
  const outreachSendOk=res=>String(res?.status||"").toUpperCase()==="SUCCESS";
  // The brand's chat in chat/search (by campaign, or by name for a follow-up, where only
  // that exact brand counts): a brand that can be written to.
  function outreachChat(addressBook,brandKey=""){
    const entry=(Array.isArray(addressBook)?addressBook:[]).find(a=>a?.actorType==="BRAND"&&a?.contextValidatorToken&&(!a.communicationStatus||a.communicationStatus==="READ_WRITE")&&(!brandKey||normalizeBrand(a.actorName)===brandKey));
    return entry?{token:String(entry.contextValidatorToken),brand:String(entry.actorName||"")}:null;
  }
  // 📌 Insistir (owner's request 2026-11-13): brands the creator wants an answer from. One
  // message per brand per week at most, for every send from this page (owner's rule: more
  // often could get the Amazon account reported). After FOLLOW_UP_NO_REPLY tries the brand
  // shows «Sin respuesta», though the creator can still write once a week.
  const FOLLOW_UP_DAYS=7, FOLLOW_UP_NO_REPLY=5, FOLLOW_UP_LIMIT=500, WEEK_MS=FOLLOW_UP_DAYS*864e5;
  // When this brand can get another message: a week after the last one that reached it.
  const outreachNextAllowed=entry=>Number(entry?.at)>0&&Number(entry?.parts)>0?Number(entry.at)+WEEK_MS:0;
  const outreachTooSoon=(entry,now=Date.now())=>outreachNextAllowed(entry)>now;
  function addFollowUp(list,row,now=Date.now()){
    const key=normalizeBrand(row?.brand); if(!key) return list||{};
    const prev=list?.[key];
    const all={...(list||{}),[key]:{brand:String(row.brand).slice(0,100),campaignId:String(row.campaignId||prev?.campaignId||"").slice(0,80),
      campaignName:String(row.campaignName||prev?.campaignName||"").slice(0,200),asin:/^[A-Z0-9]{10}$/.test(String(row.asin||""))?row.asin:(prev?.asin||""),
      ratePercent:Number(row.ratePercent)||prev?.ratePercent||0,addedAt:prev?.addedAt||now,tries:prev?.tries||0,replied:prev?.replied||false,checkedAt:prev?.checkedAt||0}};
    const keys=Object.keys(all);
    return keys.length<=FOLLOW_UP_LIMIT?all:Object.fromEntries(keys.sort((a,b)=>all[b].addedAt-all[a].addedAt).slice(0,FOLLOW_UP_LIMIT).map(k=>[k,all[k]]));
  }
  // The list as the page shows it: replied, ready today, waiting until a date, or no reply yet.
  function followUpView(list,history,now=Date.now()){
    return Object.entries(list||{}).map(([key,f])=>{
      const next=outreachNextAllowed(history?.[key]);
      const state=f.replied?"replied":next>now?"waiting":(f.tries||0)>=FOLLOW_UP_NO_REPLY?"noreply":"due";
      return {...f,brandKey:key,lastAt:Number(history?.[key]?.at)||0,nextAt:next,state};
    }).sort((a,b)=>(a.state==="due"?0:1)-(b.state==="due"?0:1)||(a.nextAt-b.nextAt)||a.brand.localeCompare(b.brand));
  }
  // messages/list (chatMessages, sender.type BRAND or CREATOR): the brand answered when the
  // newest message is theirs.
  function brandAnsweredLast(messages){
    let last=null;
    for(const m of Array.isArray(messages)?messages:[]){ const at=Number(m?.createdTimestamp)||0; if(!last||at>=last.at) last={at,type:String(m?.sender?.type||"").toUpperCase()}; }
    return last?.type==="BRAND";
  }

  // 🚫 Marcas tachadas (owner's request 2026-11-22): brands the creator does not want to write
  // to, for example because they never send samples. They show crossed out where campaigns are
  // listed and Mila.Desk never sends them a message from Mensajes a marcas or Insistir.
  const BLOCK_REASONS=Object.freeze({no_samples:"No envía muestras",no_reply:"No responde",other:"No escribir"});
  const BLOCKED_LIMIT=1000;
  function addBlockedBrand(list,row,now=Date.now()){
    const key=normalizeBrand(row?.brand); if(!key) return list||{};
    const reason=Object.hasOwn(BLOCK_REASONS,row?.reason)?row.reason:"other";
    const all={...(list||{}),[key]:{brand:String(row.brand).trim().slice(0,100),reason,note:String(row?.note||"").trim().slice(0,80),at:now}};
    return keepNewest(all,BLOCKED_LIMIT,v=>Number(v?.at)||0);
  }
  // 💡 Sugerir tachar (owner's request 2026-11-22): a brand message that says it does not send
  // samples, in Spanish or English. Only the yes/no is kept, never the text.
  const NO_SAMPLES_RE=[
    /\bno\s+(?:enviamos|ofrecemos|damos|mandamos|proporcionamos|regalamos|estamos\s+(?:enviando|ofreciendo|dando))\s+(?:\w+\s+){0,2}(?:muestras?|productos?\s+(?:gratis|gratuitos?))/i,
    /\bno\s+(?:podemos|es\s+posible)\s+(?:enviar|ofrecer|dar|mandar|proporcionar)(?:te|le|les)?\s+(?:\w+\s+){0,2}(?:muestras?|productos?\s+(?:gratis|gratuitos?))/i,
    /\b(?:sin|no\s+hay|no\s+tenemos)\s+muestras?\b/i,
    /\b(?:do\s+not|don['’]t|cannot|can['’]t|can\s+not|are\s+(?:not|unable)\s+(?:able\s+)?to|aren['’]t\s+able\s+to|won['’]t|will\s+not|unable\s+to)\s+(?:currently\s+)?(?:send|offer|provide|give|ship|supply)\s+(?:out\s+)?(?:any\s+)?(?:free\s+)?(?:samples?|products?\s+for\s+free|free\s+products?)/i,
    /\bno\s+(?:free\s+)?samples?\b/i,
    /\bsamples?\s+(?:are|is)\s+not\s+(?:available|provided|offered)/i
  ];
  const saysNoSamples=text=>{ const t=String(text||"").slice(0,4000); return !!t&&NO_SAMPLES_RE.some(r=>r.test(t)); };
  // Brands seen saying so, without the ones already crossed out or dismissed.
  const noSampleSuggestions=(seen,blocked)=>Object.entries(seen||{}).filter(([k,v])=>v&&!v.dismissed&&!(blocked&&Object.hasOwn(blocked,k)))
    .map(([brandKey,v])=>({brandKey,brand:String(v.brand||""),at:Number(v.at)||0})).sort((a,b)=>b.at-a.at);
  const blockedEntry=(list,brand)=>{ const key=normalizeBrand(brand); return key&&list&&Object.hasOwn(list,key)?list[key]:null; };
  // The words shown on the crossed-out brand (Spanish key; the pages translate it).
  const blockedReasonText=entry=>entry?.note||BLOCK_REASONS[entry?.reason]||BLOCK_REASONS.other;

  // History kept in this browser: newest wins, oldest dropped past the limit.
  function addOutreachHistory(history,brandKey,entry){
    const all={...(history||{}),[brandKey]:entry};
    const keys=Object.keys(all);
    if(keys.length<=OUTREACH_LIMITS.history) return all;
    keys.sort((a,b)=>(all[b]?.at||0)-(all[a]?.at||0));
    return Object.fromEntries(keys.slice(0,OUTREACH_LIMITS.history).map(k=>[k,all[k]]));
  }


  // ☁️ Copy in Supabase (user_backups, 25.50.0) of what lived only in this browser. Records
  // that only grow (sends, sales days, products) are always joined, so no browser loses one;
  // lists the creator edits (📌, saved messages, templates) are joined the first time only.
  const BACKUP_DOCS=Object.freeze(["outreach","follow","saved_messages","templates","sales_days","sales_cc","sales_products","blocked"]);
  const BACKUP_ALWAYS_MERGE=Object.freeze(["outreach","sales_days","sales_cc","sales_products"]);
  const BACKUP_MAX_BYTES=1900000;
  const isPlainObject=v=>!!v&&typeof v==="object"&&!Array.isArray(v);
  function newerPerKey(a,b,stamp){
    const out={...(isPlainObject(b)?b:{})};
    for(const [k,v] of Object.entries(isPlainObject(a)?a:{})) if(!(k in out)||stamp(v)>=stamp(out[k])) out[k]=v;
    return out;
  }
  function keepNewest(map,limit,stamp){
    const keys=Object.keys(map); if(keys.length<=limit) return map;
    return Object.fromEntries(keys.sort((x,y)=>stamp(map[y])-stamp(map[x])).slice(0,limit).map(k=>[k,map[k]]));
  }
  // The joined copy of one kind of data; the local copy wins a tie.
  function mergeBackupDoc(doc,local,cloud){
    const empty=v=>v==null||v===""||(Array.isArray(v)?!v.length:isPlainObject(v)&&!Object.keys(v).length);
    if(empty(cloud)) return local;
    if(empty(local)) return cloud;
    const at=v=>Number(v?.at)||0;
    if(doc==="outreach") return keepNewest(newerPerKey(local,cloud,at),OUTREACH_LIMITS.history,at);
    if(doc==="follow"){ const st=v=>Math.max(Number(v?.addedAt)||0,Number(v?.checkedAt)||0)+(Number(v?.tries)||0); return keepNewest(newerPerKey(local,cloud,st),FOLLOW_UP_LIMIT,v=>Number(v?.addedAt)||0); }
    if(doc==="sales_days"||doc==="sales_cc"){
      const days={...(cloud?.days||{}),...(local?.days||{})};
      return {...cloud,...local,days:Object.fromEntries(Object.entries(days).sort((a,b)=>b[0].localeCompare(a[0])).slice(0,120))};
    }
    if(doc==="sales_products"){ const seen=v=>Number(v?.seenAt)||0; return {...cloud,...local,products:keepNewest(newerPerKey(local?.products,cloud?.products,seen),SALES_PRODUCTS_MAX,seen)}; }
    if(doc==="blocked") return keepNewest(newerPerKey(local,cloud,at),BLOCKED_LIMIT,at);
    if(doc==="templates") return {...cloud,...Object.fromEntries(Object.entries(local).filter(([,v])=>!empty(v)))};
    return local;
  }
  const backupSize=v=>{ try{ return encodeURIComponent(JSON.stringify(v)).replace(/%[0-9A-F]{2}/g,"x").length; }catch{ return Infinity; } };

  // Access codes in batches (admin page, owner's request 2026-11-12): one code per person,
  // grouped by the name they were created with (for example, a mentor's students).
  const CODE_BATCH_LIMIT=300;
  function groupBetaCodes(codes){
    const groups=new Map();
    for(const c of codes||[]){
      const label=String(c?.label||"").trim(), key=label||"\u0000"+String(c?.code||"");
      if(!groups.has(key)) groups.set(key,{label,codes:[],uses:0,max:0});
      const g=groups.get(key); g.codes.push(c); g.uses+=Math.min(Number(c?.uses)||0,Number(c?.max_uses)||0); g.max+=Number(c?.max_uses)||0;
    }
    return [...groups.values()];
  }
  // Mentors panel (owner's request, 2026-11-15; «Propuesta de Alianza … Mentoras»). Where
  // each student of a mentor stands today, from admin_mentor_students():
  // pagando: a Paddle subscription with access (past_due still counts until Paddle ends it);
  // cancelo: had a subscription that ended; gratis: the code's free month is still running;
  // otro_acceso: has a gift or Premium given by an administrator, without a subscription;
  // sin_pagar: the free month ended and no subscription followed.
  // sin_tarjeta: redeemed a code that asks for a card, but hasn't put the card yet (owner's
  // request 2026-11-27: she was shown as «Terminó sin pagar»); only card codes give no plan.
  function mentorStudentState(row,now=Date.now()){
    const status=String(row?.sub_status||""), access=String(row?.sub_access||"");
    if(status){
      // Paying only after a real charge (owner's decision, 2026-11-16): the 14-day trial is free time.
      if(access==="active"&&status==="on_trial") return "gratis";
      if(access==="active"&&(status==="active"||status==="past_due")) return "pagando";
      return "cancelo";
    }
    if(!row?.plan) return "sin_tarjeta";
    const until=Date.parse(row?.plan_expires_at||""), running=!Number.isFinite(until)||until>now;
    if(row?.plan==="beta"&&running) return "gratis";
    // A gift or Premium you gave by hand (for example, the mentor herself): not a student who stopped.
    if((row?.plan==="regalo"||row?.plan==="premium"||row?.plan==="admin")&&running) return "otro_acceso";
    return "sin_pagar";
  }
  const MENTOR_MONTHS=6, MENTOR_RAFFLE_MIN=5;
  // A mentor gets 1 year of free Premium from the alliance start; it stays even if the
  // alliance ends early (alliance document, 2026-11-22; replaces the day-90 / 3-students rule).
  function mentorFreeYearEnd(startedAt){
    const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(startedAt||"")); if(!m) return null;
    const d=new Date(Date.UTC(+m[1]+1,+m[2]-1,+m[3]));
    if(d.getUTCDate()!==+m[3]) d.setUTCDate(0); // 29 Feb → 28 Feb
    return d.toISOString().slice(0,10);
  }
  // Counts and reminders for one partner. The alliance (6 months a mentor, 3 an influencer) starts
  // on the first paid charge of one of her students (owner, 2026-11-24), given as firstPaidAt; a
  // mentor's free Premium year still counts from started_at (the date she joined). Every 2 months
  // of the alliance with 5+ paying, a mentor gets 1 raffle of 1 free month; influencers have no
  // free-year or raffle rules (2026-11-21).
  // «Regalo de Mila.Desk» (kind "mila", 2026-11-24) is the owner's own group: counts only, no alliance rules.
  function mentorSummary({codes=[],students=[],mentor=null,now=Date.now(),kind="mentora",firstPaidAt=null}={}){
    const influencer=kind==="influencer", months=influencer?3:MENTOR_MONTHS;
    if(kind==="mila"){ mentor=null; firstPaidAt=null; }
    const count={gratis:0,pagando:0,cancelo:0,sin_pagar:0,sin_tarjeta:0,otro_acceso:0};
    for(const s of students||[]) count[mentorStudentState(s,now)]++;
    const used=(codes||[]).filter(c=>Number(c?.uses)>0).length;
    const alerts=[];
    const start=/^\d{4}-\d{2}-\d{2}$/.test(String(firstPaidAt||""))?Date.parse(firstPaidAt+"T00:00:00"):NaN;
    let endsAt=null;
    if(Number.isFinite(start)){
      const end=new Date(start); end.setMonth(end.getMonth()+months); endsAt=end.getTime();
      const left=Math.ceil((endsAt-now)/864e5);
      alerts.push({kind:"info",text:`La alianza de ${months} meses empezó el ${firstPaidAt.split("-").reverse().join("/")}, con la primera suscripción pagada.`});
      if(left<=0) alerts.push({kind:"warn",text:`La alianza de ${months} meses ya terminó: renuévala o márcala como terminada.`});
      else if(left<=30) alerts.push({kind:"warn",text:`La alianza termina en ${left} días.`});
    } else if(kind!=="mila") alerts.push({kind:"info",text:`La alianza de ${months} meses empieza con la primera suscripción pagada de ${influencer?"alguien de su público":"una de sus alumnas"}.`});
    if(kind==="mentora"){
      const yearEnd=mentorFreeYearEnd(mentor?.started_at);
      alerts.push({kind:"info",text:yearEnd?`Su año de Premium gratis va hasta el ${yearEnd.split("-").reverse().join("/")}.`:"Pon la fecha de inicio para ver hasta cuándo va su año de Premium gratis."});
    }
    // Raffle (alliance document + owner, 2026-11-23): every 2 months of an active alliance, with 5+
    // paying students, 1 raffle among her paying students; the prize is 1 free month that the owner
    // applies as a 100 % discount. A raffle not done in its 2 months does not carry over.
    if(!influencer&&Number.isFinite(start)&&now>=start&&now<endsAt&&mentor?.active!==false&&count.pagando>=MENTOR_RAFFLE_MIN){
      const s=new Date(start), periodEnd=new Date(start);
      const months=(new Date(now).getFullYear()-s.getFullYear())*12+new Date(now).getMonth()-s.getMonth()-(new Date(now).getDate()<s.getDate()?1:0);
      periodEnd.setMonth(s.getMonth()+2*(Math.floor(months/2)+1));
      alerts.push({kind:"ok",text:`Tiene ${count.pagando} alumnas pagando: le toca 1 sorteo de 1 mes gratis antes del ${new Date(Math.min(periodEnd.getTime(),endsAt)-864e5).toLocaleDateString("es-DO")} (no se acumula). Solo entre alumnas que ya pagan.`});
    }
    if(mentor&&mentor.active===false) alerts.unshift({kind:"warn",text:"Alianza marcada como terminada."});
    return {count,codes:(codes||[]).length,used,free:(codes||[]).filter(c=>c?.active&&Number(c?.uses)<Number(c?.max_uses)).length,endsAt,alerts};
  }
  // Mentor commission (proposal, 2026-11): on the owner's net (Paddle "earnings": after tax and
  // Paddle's fee), minus refunds. A charge counts 30 days after it was paid; the rate depends on
  // how many students paid that month; under 25 USD owed it carries over to the next month.
  // 2026-11-21 (owner's decisions): an annual charge gives a mentor a fixed 25 USD every year
  // and does not count toward the rate; an influencer gets a fixed 5 USD once per person, on
  // that person's first charge («Propuesta … Influencers»).
  const COMMISSION_HOLD_DAYS=30, COMMISSION_MIN_CENTS=2500;
  const COMMISSION_TIERS=[[100,0.40],[51,0.35],[26,0.30],[1,0.25]];
  function commissionRate(students){ for(const [min,rate] of COMMISSION_TIERS) if(students>=min) return rate; return 0; }
  // Fixed commissions by type. Influencer: 5 USD for a monthly first charge, 15 USD for an annual one (owner, 2026-11-21).
  const FIXED_COMMISSION_CENTS={anual:2500,primero:500,primero_anual:1500};
  // shortcut: annual is told by the amount (180/150 USD vs 20 USD a month); store the billing interval if prices change a lot.
  const ANNUAL_MIN_TOTAL_CENTS=6000;
  const isAnnualCharge=p=>(Number(p?.total_cents)||0)>=ANNUAL_MIN_TOTAL_CENTS;
  // 💰 Ganancias (owner, 2026-11-24): totals, months, where the money comes from and subscriptions.
  // payments: billing_payments rows with source (partner group or null); refunds carry positive
  // amounts. partners: [{name,kind}]; commissions: {earnedCents,paidCents,owedCents} already summed.
  function earningsSummary({payments=[],subscriptions=[],partners=[],commissions=null,grants=[],now=Date.now()}={}){
    const paid=p=>p?.kind==="charge"&&["completed","paid"].includes(p.status);
    const refund=p=>p?.kind==="refund"&&p.status==="approved";
    const n=v=>Number(v)||0, month=p=>String(p.occurred_at||"").slice(0,7);
    const blank=()=>({grossCents:0,taxCents:0,feeCents:0,netCents:0,refundCents:0,refundNetCents:0,charges:0,refunds:0});
    const add=(t,p)=>{
      if(paid(p)){ t.grossCents+=n(p.total_cents); t.taxCents+=n(p.tax_cents); t.feeCents+=n(p.fee_cents); t.netCents+=n(p.net_cents); t.charges++; }
      else if(refund(p)){ t.refundCents+=n(p.total_cents); t.refundNetCents+=n(p.net_cents); t.refunds++; }
    };
    const totals=blank(), months=new Map(), sources=new Map();
    const kindOf=name=>(partners||[]).find(m=>String(m.name).toLowerCase()===String(name||"").toLowerCase())?.kind;
    for(const p of payments||[]){
      if(!paid(p)&&!refund(p)) continue;
      add(totals,p);
      const m=month(p); if(/^\d{4}-\d{2}$/.test(m)){ if(!months.has(m)) months.set(m,{month:m,...blank()}); add(months.get(m),p); }
      // People from a code group that is not a partner (beta lists, prizes) count as the general public.
      const kind=kindOf(p.source), key=kind?p.source:"";
      if(!sources.has(key)) sources.set(key,{source:key,kind:kind||"publico",people:new Set(),...blank()});
      const src=sources.get(key); add(src,p); if(paid(p)&&p.user_id) src.people.add(p.user_id);
    }
    const keep=t=>t.netCents-t.refundNetCents;
    const out=t=>({...t,keepCents:keep(t)});
    const subs={active:0,trial:0,trialAnnual:0,monthly:0,annual:0,canceledThisMonth:0,pastDue:0};
    const yearly=s=>/year|anual/i.test(String(s?.product||""));
    const thisMonth=new Date(now).toISOString().slice(0,7);
    for(const s of subscriptions||[]){
      if(s?.provider&&s.provider!=="paddle") continue;
      if(s?.status==="on_trial"&&s.access==="active"){ subs.trial++; if(yearly(s)) subs.trialAnnual++; }
      else if(s?.status==="active"){ subs.active++; if(yearly(s)) subs.annual++; else subs.monthly++; }
      else if(s?.status==="past_due") subs.pastDue++;
      if(s?.status==="canceled"&&String(s.updated_at||"").slice(0,7)===thisMonth) subs.canceledThisMonth++;
    }
    // shortcut: fixed income uses list prices (20 USD a month, 180 USD a year); read each subscription's price if discounts become common.
    subs.recurringCents=subs.monthly*2000+Math.round(subs.annual*18000/12);
    // 🔮 If every free trial paid (owner, 2026-11-28): card trials at their plan's price, and people
    // in a code's free month (plan beta with an end date; gifts never count) at the monthly price.
    subs.trialCents=(subs.trial-subs.trialAnnual)*2000+Math.round(subs.trialAnnual*18000/12);
    subs.freeTrial=(grants||[]).filter(g=>g?.plan==="beta"&&Date.parse(g.expires_at||"")>now).length;
    subs.freeTrialCents=subs.freeTrial*2000;
    subs.potentialCents=subs.recurringCents+subs.trialCents+subs.freeTrialCents;
    const total=out(totals), c=commissions||{earnedCents:0,paidCents:0,owedCents:0};
    return {
      totals:{...total,commissionCents:c.earnedCents,commissionPaidCents:c.paidCents,commissionOwedCents:c.owedCents,realCents:total.keepCents-c.earnedCents},
      months:[...months.values()].sort((a,b)=>a.month.localeCompare(b.month)).map(out),
      sources:[...sources.values()].map(x=>({...out(x),people:x.people.size})).sort((a,b)=>b.grossCents-a.grossCents),
      subscriptions:subs
    };
  }
  // 🟢 En línea (owner's request 2026-11-28): who is using Mila.Desk now (seen in the last
  // PRESENCE_ONLINE_MIN minutes; it says «still here» every PRESENCE_EVERY_MIN while open) and today.
  const PRESENCE_EVERY_MIN=3, PRESENCE_ONLINE_MIN=6;
  // One Mila.Desk account = one Amazon account (owner's request 2026-11-28). link is what
  // amazon_link_check() answered; tr translates and fills {handle}. '' when nothing is blocked.
  function amazonLinkMessage(link,tr=(x,v)=>String(x).replace(/\{(\w+)\}/g,(m,k)=>v?.[k]??m)){
    const handle=String(link?.handle||"").trim();
    if(link?.status==="other") return handle
      ?tr("Esta cuenta de Mila.Desk está ligada a otra cuenta de Amazon ({handle}). Entra en Amazon con esa cuenta para usarla. Si cambiaste de cuenta de Amazon, escríbenos a milanes@mila-desk.com.",{handle})
      :tr("Esta cuenta de Mila.Desk está ligada a otra cuenta de Amazon. Entra en Amazon con esa cuenta para usarla. Si cambiaste de cuenta de Amazon, escríbenos a milanes@mila-desk.com.");
    if(link?.status==="taken") return handle
      ?tr("Esta cuenta de Amazon ({handle}) ya está ligada a otra cuenta de Mila.Desk. Cierra sesión y entra con esa cuenta. Si es un error, escríbenos a milanes@mila-desk.com.",{handle})
      :tr("Esta cuenta de Amazon ya está ligada a otra cuenta de Mila.Desk. Cierra sesión y entra con esa cuenta. Si es un error, escríbenos a milanes@mila-desk.com.");
    return "";
  }
  function presenceSummary(rows,now=Date.now()){
    const day=new Date(now); day.setHours(0,0,0,0);
    const seen=(rows||[]).map(r=>({...r,at:Date.parse(r?.last_seen_at||"")})).filter(r=>Number.isFinite(r.at)&&r.at<=now+60000).sort((a,b)=>b.at-a.at);
    const online=seen.filter(r=>now-r.at<=PRESENCE_ONLINE_MIN*60000);
    const today=seen.filter(r=>r.at>=day.getTime());
    return {online,today,onlineCount:online.length,todayCount:today.length};
  }
  // Pages of the extension call this once: «still here» now, every few minutes and when the tab
  // comes back, only while it is visible. The service worker sends it (MILA_PRESENCE).
  function presenceStart(){
    if(typeof document==="undefined"||!globalThis.chrome?.runtime?.sendMessage) return;
    const ping=()=>{ if(document.hidden) return; try{ Promise.resolve(chrome.runtime.sendMessage({type:"MILA_PRESENCE"})).catch(()=>{}); }catch{} };
    ping(); setInterval(ping,PRESENCE_EVERY_MIN*60000); document.addEventListener("visibilitychange",ping);
  }
  // CSV of the payments for the accountant (dates in UTC, amounts in USD).
  function earningsCsv(payments){
    const q=v=>{ let t=String(v??""); if(/^[=+\-@]/.test(t)) t="'"+t; // no spreadsheet formulas from labels
      return /[",\n]/.test(t)?'"'+t.replace(/"/g,'""')+'"':t; };
    const usd=c=>(Number(c||0)/100).toFixed(2);
    const rows=[["fecha","tipo","estado","moneda","total","impuesto","comision_paddle","neto","origen","id"]];
    for(const p of payments||[]) rows.push([String(p.occurred_at||"").slice(0,19).replace("T"," "),p.kind==="refund"?"reembolso":p.kind==="charge"?"cobro":p.kind,p.status,p.currency,usd(p.total_cents),usd(p.tax_cents),usd(p.fee_cents),usd(p.net_cents),p.source||"público",p.external_id]);
    return rows.map(r=>r.map(q).join(",")).join("\n")+"\n";
  }
  // The day (YYYY-MM-DD) of the first paid charge among a partner's payments, or null. A 0 USD
  // charge (the start of a free trial) does not count.
  function firstPaidCharge(payments){
    let first=null;
    for(const p of payments||[]){
      const at=Date.parse(p?.occurred_at||"");
      if(p?.kind==="charge"&&["completed","paid"].includes(p.status)&&Number(p.total_cents)>0&&Number.isFinite(at)&&(first===null||at<first)) first=at;
    }
    return first===null?null:new Date(first).toISOString().slice(0,10);
  }
  function mentorCommissions({payments=[],payouts=[],now=Date.now(),kind="mentora"}={}){
    const influencer=kind==="influencer";
    if(kind==="mila") payments=[]; // the owner's own group earns no commission
    const refunded=new Map();
    for(const p of payments||[]) if(p?.kind==="refund"&&p.status==="approved"&&p.transaction_id)
      refunded.set(p.transaction_id,(refunded.get(p.transaction_id)||0)+Math.max(0,Number(p.net_cents)||0));
    const charges=(payments||[]).filter(p=>p?.kind==="charge"&&["completed","paid"].includes(p.status)&&Number.isFinite(Date.parse(p.occurred_at||"")))
      .sort((a,b)=>Date.parse(a.occurred_at)-Date.parse(b.occurred_at));
    // Influencer: only each person's first charge counts (a later one never replaces it).
    const firstOf=new Map();
    for(const p of charges) if(p.user_id&&!firstOf.has(p.user_id)) firstOf.set(p.user_id,p.external_id);
    const months=new Map(), pending=[]; let pendingCents=0, pendingCount=0;
    for(const p of charges){
      if(influencer&&(!p.user_id||firstOf.get(p.user_id)!==p.external_id)) continue;
      const at=Date.parse(p.occurred_at);
      const net=Math.max(0,(Number(p.net_cents)||0)-(refunded.get(p.external_id)||0));
      const annual=isAnnualCharge(p);
      const type=influencer?(annual?"primero_anual":"primero"):annual?"anual":"mensual";
      if(now<at+COMMISSION_HOLD_DAYS*864e5){
        pendingCents+=net; pendingCount++;
        pending.push({user_id:p.user_id||null,type,occurred_at:p.occurred_at,releaseAt:new Date(at+COMMISSION_HOLD_DAYS*864e5).toISOString(),netCents:net,
          estimateCents:!net?0:type==="mensual"?Math.round(net*COMMISSION_TIERS[COMMISSION_TIERS.length-1][1]):FIXED_COMMISSION_CENTS[type]});
        continue;
      }
      if(!net) continue;
      const key=new Date(at).toISOString().slice(0,7);
      const m=months.get(key)||{month:key,netCents:0,students:new Set(),fixedCents:0,fixedCount:0,items:[]};
      if(type==="mensual"){ m.netCents+=net; if(p.user_id) m.students.add(p.user_id); }
      else { m.fixedCents+=FIXED_COMMISSION_CENTS[type]; m.fixedCount++; }
      m.items.push({user_id:p.user_id||null,type,occurred_at:p.occurred_at,netCents:net});
      months.set(key,m);
    }
    const list=[...months.values()].sort((a,b)=>a.month.localeCompare(b.month)).map(m=>{
      const rate=m.students.size?commissionRate(m.students.size):0;
      const percentCents=Math.round(m.netCents*rate);
      return {month:m.month,students:m.students.size,netCents:m.netCents,rate,fixedCount:m.fixedCount,fixedCents:m.fixedCents,
        commissionCents:percentCents+m.fixedCents,items:m.items.map(i=>({...i,commissionCents:i.type==="mensual"?Math.round(i.netCents*rate):FIXED_COMMISSION_CENTS[i.type]}))};
    });
    const earnedCents=list.reduce((t,m)=>t+m.commissionCents,0);
    const paidCents=(payouts||[]).reduce((t,p)=>t+Math.max(0,Number(p?.amount_cents)||0),0);
    const owedCents=earnedCents-paidCents;
    const pendingEstimateCents=pending.reduce((t,p)=>t+p.estimateCents,0);
    return {months:list,pending,pendingCents,pendingCount,pendingEstimateCents,earnedCents,paidCents,owedCents,canPay:owedCents>=COMMISSION_MIN_CENTS};
  }
  // Mentor panel (owner's request 2026-11-22): the rate she earns this month so far, from how many
  // different students paid a monthly charge this calendar month (refunded charges don't count),
  // and how many more she needs for the next tier.
  function mentorRateNow({payments=[],now=Date.now()}={}){
    const month=new Date(now).toISOString().slice(0,7), refunded=new Set();
    for(const p of payments||[]) if(p?.kind==="refund"&&p.status==="approved"&&p.transaction_id) refunded.add(p.transaction_id);
    const who=new Set();
    for(const p of payments||[]) if(p?.kind==="charge"&&["completed","paid"].includes(p.status)&&!isAnnualCharge(p)
      &&!refunded.has(p.external_id)&&String(p.occurred_at||"").slice(0,7)===month&&p.user_id) who.add(p.user_id);
    const students=who.size, rate=commissionRate(students);
    const up=COMMISSION_TIERS.slice().reverse().find(([min])=>min>students);
    return {month,students,rate,next:up?{students:up[0],missing:up[0]-students,rate:up[1]}:null};
  }
  // Days left of a student's free time (beta code or the 14-day trial); null when not known.
  function freeDaysLeft(row,now=Date.now()){
    // A trial's access_until carries one extra day of margin (billing-webhook paddleAccess).
    const trial=row?.sub_status==="on_trial", until=Date.parse(trial?row?.sub_access_until||"":row?.plan_expires_at||"")-(trial?864e5:0);
    return Number.isFinite(until)?Math.max(0,Math.ceil((until-now)/864e5)):null;
  }
  // A partner's own panel (2026-11-21): what happened with her students, newest first. Rows come
  // from my_partner_panel(): students {id,username,code,redeemed_at,sub_status,sub_since,
  // sub_access_until}, payments {id,student,kind,status,total_cents,occurred_at}, payouts {amount_cents,paid_at}.
  function partnerActivity({students=[],payments=[],payouts=[]}={}){
    const who=new Map((students||[]).map(s=>[s.id,s.username||tr("Sin usuario")]));
    const usd=c=>"$"+((Number(c)||0)/100).toFixed(2);
    const out=[];
    for(const s of students||[]){
      const name=s.username||tr("Sin usuario");
      if(s.redeemed_at) out.push({at:s.redeemed_at,type:"codigo",text:tr("{name} canjeó tu código {code}",{name:name,code:s.code||""})});
      if(s.sub_since) out.push({at:s.sub_since,type:"suscripcion",text:tr("{name} empezó su suscripción",{name:name})});
      if(s.sub_status==="canceled"&&s.sub_access_until) out.push({at:s.sub_access_until,type:"cancelo",text:tr("{name} canceló su suscripción",{name:name})});
    }
    for(const p of payments||[]){
      const name=who.get(p.student)||tr("Una persona");
      if(p.kind==="charge"&&["completed","paid"].includes(p.status)) out.push({at:p.occurred_at,type:"pago",text:tr("{name} pagó {amount}",{name:name,amount:usd(p.total_cents)})});
      else if(p.kind==="refund"&&p.status==="approved") out.push({at:p.occurred_at,type:"reembolso",text:tr("{name} recibió un reembolso de {amount}",{name:name,amount:usd(p.total_cents)})});
    }
    for(const p of payouts||[]) out.push({at:p.paid_at,type:"te_pagamos",text:tr("Te pagamos {amount}",{amount:usd(p.amount_cents)})});
    return out.filter(e=>Number.isFinite(Date.parse(e.at||""))).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
  }
  // A list for Excel or Google Sheets. Quotes the label, which the admin types freely.
  function codeBatchCsv(codes,{label="",days=null,until=""}={}){
    const q=v=>{ const s=String(v??""); return /[",\n;]/.test(s)||/^[=+\-@]/.test(s)?'"'+s.replace(/^([=+\-@])/,"'$1").replace(/"/g,'""')+'"':s; };
    return ["Código,Nombre,Días de acceso,Canjear antes del",...(codes||[]).map(c=>[c,label,days??"Sin fin",until||""].map(q).join(","))].join("\r\n")+"\r\n";
  }

  // Access state from my_access() in Supabase: {active, plan, source, expires_at}.
  // Labels without «Plan» (owner's request 2026-11-22): there is no beta any more; a code's free month is a free trial.
  const ACCESS_PLAN_LABELS={admin:"Administrador",premium:"Premium",beta:"Prueba gratis",regalo:"Regalo"};
  function normalizeAccess(raw){
    const plan=Object.prototype.hasOwnProperty.call(ACCESS_PLAN_LABELS,raw?.plan)?raw.plan:null;
    const expiresAt=raw?.expires_at&&!isNaN(Date.parse(raw.expires_at))?new Date(raw.expires_at).toISOString():null;
    return {active:!!plan&&raw?.active===true,plan,source:raw?.source?String(raw.source):null,expiresAt};
  }
  function describeAccess(access, now=Date.now()){
    const a=normalizeAccess({...access,expires_at:access?.expiresAt??access?.expires_at});
    if(!a.plan) return tr("Gratis");
    const label=tr(ACCESS_PLAN_LABELS[a.plan]);
    if(a.plan==="admin") return label+tr(" · acceso completo");
    if(a.source==="licencia"&&a.active) return label+tr(" · suscripción activa");
    const date=iso=>{ const ms=Date.parse(iso); return formatShortDateEs(ms)+" "+new Date(ms).getFullYear(); };
    if(!a.active) return label+tr(" · venció el ")+date(a.expiresAt);
    return label+(a.expiresAt?tr(" · hasta el ")+date(a.expiresAt):tr(" · sin fecha de fin"));
  }
  // Authorship mark: see LICENSE.txt and SEGURIDAD.md.
  const ORIGIN="Mila.Desk (c) 2026 Jhoun Milanes (Milanes Production). MD-ORIGIN-7F3A91C2";
  // First letter of the username, for the round mark in the popup header.
  function profileInitial(name){
    const first=Array.from(String(name||"").trim())[0];
    return first?first.toLocaleUpperCase():"";
  }
  // Short label beside the username. An access that ended counts as the free plan.
  // trial: a paid subscription still in its free days (Paddle on_trial) also reads «Prueba gratis».
  function accessPlanLabel(access,{trial=false}={}){
    const a=normalizeAccess({...access,expires_at:access?.expiresAt??access?.expires_at});
    if(!a.active) return tr("Gratis");
    if(a.plan==="premium"&&trial) return tr("Prueba gratis");
    return tr(ACCESS_PLAN_LABELS[a.plan]);
  }
  // Messages for redeem_access_code() answers.
  function redeemMessage(result){
    // Mentor code that asks for a card (2026-11-19): the payment page opens next.
    if(result?.ok&&result.card) return tr("Código aceptado. Ahora se abre la página de pago: pon tu tarjeta para empezar tu prueba gratis. Hoy no se te cobra nada.");
    if(result?.ok) return result.kept?tr("Código aceptado. Ya tenías un acceso igual o más largo; lo conservas."):tr("¡Listo! Acceso activado.");
    return ({invalid:tr("Ese código no existe o está desactivado."),expired:tr("Ese código ya no se puede usar (venció)."),
      already_used:tr("Ya usaste este código."),exhausted:tr("Ese código ya alcanzó su límite de usos."),
      // One free access per person (owner's decision, 2026-11-15); the code stays unused.
      has_access:tr("Ya tienes acceso Premium. Este código no hace falta: guárdalo para otra persona."),
      had_free:tr("Esta cuenta ya usó su acceso gratis (un código, la prueba de 14 días o un regalo). Los códigos son para cuentas que nunca lo han tenido."),
      prize_used:tr("Ya canjeaste un código de premio antes.")})[result?.reason]||tr("No se pudo activar el código.");
  }

  // Suggestions and bug reports (25.35.0). Only the version and a short browser label go
  // with the message, and only if the creator leaves the box checked.
  const FEEDBACK_LIMITS=Object.freeze({min:5,max:2000});
  function feedbackBrowser(userAgent,platform){
    const ua=String(userAgent||"");
    const found=[["Edge",/Edg\/(\d+)/],["Opera",/OPR\/(\d+)/],["Chrome",/Chrome\/(\d+)/]].map(([name,re])=>{const m=ua.match(re);return m?name+" "+m[1]:"";}).find(Boolean);
    const browser=found||"Navegador";
    const p=String(platform||"").trim()||(/Mac OS X/.test(ua)?"macOS":/Windows/.test(ua)?"Windows":/CrOS/.test(ua)?"ChromeOS":/Linux/.test(ua)?"Linux":"");
    return (p?browser+" · "+p:browser).slice(0,300);
  }
  function feedbackCheck(text){
    const n=String(text||"").trim().length;
    if(n<FEEDBACK_LIMITS.min) return  tr("Escribe un poco más para que podamos entenderlo.");
    if(n>FEEDBACK_LIMITS.max) return  tr("El mensaje es muy largo (máximo 2000 caracteres).");
    return "";
  }
  function feedbackMessage(result){
    if(result?.ok) return  tr("¡Gracias! Lo recibimos y lo revisaremos.");
    return ({limit:tr("Ya enviaste 5 mensajes hoy. Inténtalo mañana o escríbenos a milanes@mila-desk.com."),
      too_short:tr("Escribe un poco más para que podamos entenderlo."),too_long:tr("El mensaje es muy largo (máximo 2000 caracteres).")})[result?.reason]||tr("No se pudo enviar. Inténtalo más tarde.");
  }


  // «¿Qué se vendió?» (owner's method, 25.25.0): Amazon hides which product sold at low
  // volume, so it is deduced from the day's totals and the known products' price and
  // onsite commission range. Only what the reports page shows is read.
  function parseReportMoney(text){
    const t=String(text||"").trim();
    if(!t||t==="-") return null;
    const n=Number(t.replace(/[~$,\s]/g,""));
    return Number.isFinite(n)?n:null;
  }
  // One row of the report's daily table. Amazon has shown two layouts, told apart by their
  // shape and not by language: date, clicks, shipped, returned, revenue, earnings, bonus;
  // or date, clicks, ordered, conversion %, ordered revenue, shipped, returned, revenue,
  // earnings, bonus. Any other table's row gives null.
  function parseSalesRow(cells){
    if(!Array.isArray(cells)||cells.length<7) return null;
    const c=cells.map(x=>String(x||"").trim());
    if(!/^\d{4}-\d{2}-\d{2}$/.test(c[0])) return null;
    const int=t=>{ const n=Number(t.replace(/[~,\s]/g,"")); return t===""||t==="-"||!Number.isInteger(n)?null:n; };
    const wide=c.length>=10&&/%$|^-$/.test(c[3]);
    const [shipped,returned,revenue,earnings]=wide?[5,6,7,8]:[2,3,4,5];
    if(!/^[~\s]*\$|^-$/.test(c[revenue])||!/^[~\s]*\$|^-$/.test(c[earnings])) return null;
    return {date:c[0],clicks:int(c[1]),shipped:int(c[shipped]),returned:int(c[returned]),revenue:parseReportMoney(c[revenue]),earnings:parseReportMoney(c[earnings]),estimated:[1,shipped,returned,revenue,earnings].some(i=>c[i].includes("~"))};
  }
  // Creator Connections earnings per day, from the chart of the reports' «Resumen» tab
  // (sales-chart-hook.js). Amazon does not say which product they came from.
  function normalizeCcDays(list){
    const out={};
    for(const d of Array.isArray(list)?list.slice(0,400):[]){
      const date=String(d?.date||""), e=Number(d?.earnings);
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(e)||e<0||e>100000) continue;
      out[date]=Math.round(e*100)/100;
    }
    return out;
  }
  function mergeCcDays(previous,days,keep=120){
    const merged={...(previous||{}),...(days||{})};
    return Object.fromEntries(Object.entries(merged).sort((a,b)=>b[0].localeCompare(a[0])).slice(0,keep));
  }
  // Adds ccEarnings to the days of the «Comisiones» table, and a day of its own for a
  // date that only the chart has.
  function withCcEarnings(days,cc){
    const byDate=new Map((Array.isArray(days)?days:[]).filter(d=>d?.date).map(d=>[d.date,{...d}]));
    for(const [date,earnings] of Object.entries(cc||{})){
      if(!(Number(earnings)>0)&&!byDate.has(date)) continue;
      const day=byDate.get(date)||{date,clicks:null,shipped:null,returned:null,revenue:null,earnings:null,ccOnly:true};
      day.ccEarnings=Number(earnings);
      byDate.set(date,day);
    }
    return [...byDate.values()];
  }
  // Only days with a likely product are shown (owner's decision, 2026-11-07).
  function identifiedSalesDays(days){
    return (Array.isArray(days)?days:[]).filter(d=>d?.result?.status==="seguro"||d?.result?.status==="probable");
  }
  function mergeSalesDays(previous,days,keep=120){
    const merged={...(previous||{})};
    for(const d of days||[]) if(d?.date) merged[d.date]=d;
    return Object.fromEntries(Object.entries(merged).sort((a,b)=>b[0].localeCompare(a[0])).slice(0,keep));
  }
  // Products Mila.Desk knows for «¿Qué se vendió?». Video Intelligence's lookups are
  // removed 14 days after they were saved, which left almost nothing to compare with
  // (owner's report, 2026-11-10: "solo me aparece un resultado"). So the facts are also
  // kept apart, in milaVi:user:<id>:salesProducts (180 days), and products with a
  // price history count too (title unknown, prices from the history).
  const SALES_PRODUCTS_KEEP_MS=180*24*60*60*1000, SALES_PRODUCTS_MAX=3000;
  const salesProductsKey=userId=>`milaVi:user:${userId}:salesProducts`;
  function salesCatalog(entries,userId,now=Date.now()){
    const byAsin=new Map(), prefix=`milaVi:user:${userId}:lookup:v6:`;
    for(const [key,value] of Object.entries(entries||{})){
      if(!key.startsWith(prefix)) continue;
      const asin=key.slice(prefix.length).split(":")[0], data=value?.data||{}, p=data.placement||{};
      if(!/^[A-Z0-9]{10}$/.test(asin)) continue;
      const known=byAsin.get(asin)||{asin,title:"",price:null,range:null,savedAt:0};
      if(!known.title&&p.title) known.title=String(p.title);
      const saved=Number(value?.savedAt)||0;
      const price=Number(data.price??p.price);
      if(price>0&&saved>=known.savedAt){ known.price=price; known.savedAt=saved; }
      const range=onsiteRateRange(data.basePercent,p.crumbs);
      if(range) known.range=range;
      byAsin.set(asin,known);
    }
    const stored=entries?.[salesProductsKey(userId)]?.products;
    for(const s of Object.values(stored&&typeof stored==="object"?stored:{})){
      if(!/^[A-Z0-9]{10}$/.test(String(s?.asin||""))||now-(Number(s.seenAt)||0)>SALES_PRODUCTS_KEEP_MS) continue;
      const known=byAsin.get(s.asin);
      if(!known){ byAsin.set(s.asin,{asin:s.asin,title:String(s.title||""),price:Number(s.price)>0?Number(s.price):null,range:s.range||null,savedAt:0}); continue; }
      if(!known.title&&s.title) known.title=String(s.title);
      if(!(known.price>0)&&Number(s.price)>0) known.price=Number(s.price);
      if(!known.range&&s.range) known.range=s.range;
    }
    for(const key of Object.keys(entries||{})){
      const m=key.match(/^milaVi:price:com:([A-Z0-9]{10})$/);
      if(m&&!byAsin.has(m[1])&&Array.isArray(entries[key]?.obs)&&entries[key].obs.length) byAsin.set(m[1],{asin:m[1],title:"",price:null,range:null,savedAt:0});
    }
    return [...byAsin.values()].map(({savedAt,...x})=>({...x,history:entries?.[`milaVi:price:com:${x.asin}`]?.obs||[]}));
  }
  // A product of the creator's videos from public facts (title, price and categories of
  // Mila.Desk's shared cache) and, when known, the creator's standard rate for it.
  function salesProductFromFacts(asin,facts,baseRate){
    if(!/^[A-Z0-9]{10}$/.test(String(asin||""))) return null;
    const price=Number(facts?.price);
    const range=baseRate!=null&&Number(baseRate)>0?onsiteRateRange(Math.round(Number(baseRate)*10000)/100,facts?.crumbs):null;
    return {asin,title:String(facts?.title||"").slice(0,300),price:price>0?Math.round(price*100)/100:null,range};
  }
  // Fills the catalog with more products: new ones are added (with their price
  // history), known ones only get what they lacked.
  function addSalesProducts(catalog,extra,entries){
    const byAsin=new Map((catalog||[]).map(p=>[p.asin,{...p}]));
    for(const e of extra||[]){
      if(!e?.asin) continue;
      const known=byAsin.get(e.asin);
      if(!known){ byAsin.set(e.asin,{asin:e.asin,title:e.title||"",price:e.price||null,range:e.range||null,history:entries?.[`milaVi:price:com:${e.asin}`]?.obs||[]}); continue; }
      if(!known.title&&e.title) known.title=e.title;
      if(!(known.price>0)&&e.price>0) known.price=e.price;
      if(!known.range&&e.range) known.range=e.range;
    }
    return [...byAsin.values()];
  }
  // The list kept apart: what is known now (title, price, commission range) replaces
  // what was kept; gaps keep the older value. Old and extra entries are dropped.
  function keepSalesProducts(stored,products,now=Date.now()){
    const out={};
    for(const s of Object.values(stored&&typeof stored==="object"?stored:{})) if(/^[A-Z0-9]{10}$/.test(String(s?.asin||""))&&now-(Number(s.seenAt)||0)<=SALES_PRODUCTS_KEEP_MS) out[s.asin]=s;
    for(const p of products||[]){
      if(!/^[A-Z0-9]{10}$/.test(String(p?.asin||""))) continue;
      const title=String(p.title||"").slice(0,300), price=Number(p.price)>0?Math.round(Number(p.price)*100)/100:null, range=p.range&&Number.isFinite(p.range.min)&&Number.isFinite(p.range.max)?{min:p.range.min,max:p.range.max,exact:!!p.range.exact}:null;
      if(!title&&!price&&!range) continue;
      const old=out[p.asin]||{};
      out[p.asin]={asin:p.asin,title:title||old.title||"",price:price??old.price??null,range:range||old.range||null,seenAt:now};
    }
    return Object.fromEntries(Object.entries(out).sort((a,b)=>(b[1].seenAt||0)-(a[1].seenAt||0)).slice(0,SALES_PRODUCTS_MAX));
  }
  // Amazon's report grouped by «Producto vinculado» (new in Nov 2026, owner's report 2026-11-22):
  // the products people clicked from the creator's content, with clicks. A row is read from its
  // product link (/gp/product/ or /dp/ + ASIN) and the clicks cell next to the title. Amazon hides
  // each product's sales for low volumes, so only the product and its clicks are kept.
  // «¿Qué se vendió?» is turned off for now (owner's request 2026-11-22: still too many wrong
  // guesses). Set to true to bring back the reports button, its setting and the page.
  const SALES_PANEL_ENABLED=false;
  function parseLinkedProductRow(cells,href){
    const m=String(href||"").match(/\/(?:gp\/product|dp)\/([A-Z0-9]{10})(?:[/?#]|$)/);
    if(!m||!Array.isArray(cells)||cells.length<3) return null;
    const title=String(cells[0]||"").trim().replace(/^\d+\s*/,"").replace(/\s+/g," ").slice(0,300);
    const clicks=Number(String(cells[1]||"").replace(/[^0-9]/g,""));
    return {asin:m[1],title,clicks:Number.isFinite(clicks)?clicks:0};
  }
  const SALES_LINKED_KEEP_MS=180*24*60*60*1000, SALES_LINKED_MAX=2000;
  const salesLinkedKey=userId=>`milaVi:user:${userId}:salesLinked`;
  // Keeps the linked products seen (180 days); the clicks are the highest seen for each product.
  function keepLinkedProducts(stored,rows,now=Date.now()){
    const out={};
    for(const s of Object.values(stored&&typeof stored==="object"?stored:{})) if(/^[A-Z0-9]{10}$/.test(String(s?.asin||""))&&now-(Number(s.seenAt)||0)<=SALES_LINKED_KEEP_MS) out[s.asin]=s;
    for(const r of rows||[]){
      if(!/^[A-Z0-9]{10}$/.test(String(r?.asin||""))) continue;
      const old=out[r.asin]||{};
      out[r.asin]={asin:r.asin,title:String(r.title||old.title||"").slice(0,300),clicks:Math.max(Number(r.clicks)||0,Number(old.clicks)||0),seenAt:now};
    }
    return Object.fromEntries(Object.entries(out).sort((a,b)=>(b[1].seenAt||0)-(a[1].seenAt||0)).slice(0,SALES_LINKED_MAX));
  }
  // Only the creator's own products can be the day's sale (owner's report 2026-11-22: «Probable»
  // showed products she never made a video of). Products merely viewed on Amazon used to count too.
  function ownSalesCatalog(catalog,ownAsins,clicksByAsin){
    const own=new Set(ownAsins||[]);
    return (catalog||[]).filter(p=>own.has(p.asin)).map(p=>({...p,clicks:Number(clicksByAsin?.[p.asin])||0}));
  }
  function pricesForDate(product,date){
    const end=Date.parse(`${date}T23:59:59Z`);
    const obs=(product?.history||[]).filter(o=>Number(o?.p)>0).sort((a,b)=>a.t-b.t);
    const before=obs.filter(o=>o.t<=end).pop()||obs[0];
    return [...new Set([before?.p,product?.price].map(Number).filter(p=>p>0).map(p=>Math.round(p*100)))];
  }
  function deduceDaySales(day,products,{maxItems=6,maxResults=5,maxSteps=200000}={}){
    const items=Number(day?.shipped);
    if(!(items>0)) return {status:"none",matches:[],total:0};
    if(day.revenue==null) return {status:"no_determinado",reason:tr("Amazon no muestra los ingresos de ese día."),matches:[],total:0};
    if(items>maxItems) return {status:"no_determinado",reason:tr("Demasiadas ventas ese día para deducirlas."),matches:[],total:0};
    const target=Math.round(day.revenue*100), earned=day.earnings==null?null:Math.round(day.earnings*100);
    const options=[];
    for(const product of products||[]) for(const cents of pricesForDate(product,day.date)) if(cents<=target+2) options.push({product,cents});
    const found=new Map(); let steps=0;
    const walk=(start,left,sum,picked)=>{
      if(++steps>maxSteps) return;
      if(left===0){
        if(Math.abs(sum-target)>2) return;
        const id=picked.map(o=>o.product.asin).sort().join("+");
        if(!found.has(id)) found.set(id,picked.slice());
        return;
      }
      for(let i=start;i<options.length;i++){
        if(sum+options[i].cents>target+2) continue;
        picked.push(options[i]); walk(i,left-1,sum+options[i].cents,picked); picked.pop();
      }
    };
    walk(0,items,0,[]);
    const judged=[];
    for(const picked of found.values()){
      const known=picked.every(o=>o.product.range);
      let fit=null;
      if(known&&earned!=null){
        const min=picked.reduce((a,o)=>a+o.cents*o.product.range.min/100,0), max=picked.reduce((a,o)=>a+o.cents*o.product.range.max/100,0), slack=picked.length+1;
        fit=earned>=min-slack&&earned<=max+slack;
      }
      if(fit===false) continue;
      judged.push({fit,products:picked.map(o=>({asin:o.product.asin,title:o.product.title,price:o.cents/100,clicks:Number(o.product.clicks)||0}))});
    }
    // A combination that fits the commission first; then the one whose products got more clicks.
    const clicksOf=j=>j.products.reduce((a,x)=>a+(Number(x.clicks)||0),0);
    judged.sort((a,b)=>(b.fit===true)-(a.fit===true)||clicksOf(b)-clicksOf(a));
    const status=!judged.length?"no_determinado":judged.length===1&&judged[0].fit===true?"seguro":"probable";
    return {status,matches:judged.slice(0,maxResults),total:judged.length,reason:judged.length?"":tr("Ningún producto conocido encaja con esos totales."),incomplete:steps>maxSteps};
  }

  // Collaborations from the Messages chat: same brand despite capitals or spaces.
  const COLLAB_STAGES=["POR RESPONDER","PENDIENTE","PRODUCTO POR RECIBIR","PRODUCTO RECIBIDO","CONTENIDO EN PROCESO","CONTENIDO ENTREGADO","COLABORACIÓN FINALIZADA"];
  function findCollaborationKey(collaborations,brand){
    const wanted=normalizeBrand(brand);
    return wanted?Object.keys(collaborations||{}).find(name=>normalizeBrand(name)===wanted)||null:null;
  }

  function chunk(list, size){
    const out=[];
    for(let i=0;i<(list||[]).length;i+=size) out.push(list.slice(i,i+size));
    return out;
  }

  // ⑤ Tareas (25.42.0, owner's choices 2026-11-10): what needs doing, from data the
  // extension already keeps in this browser (no Amazon requests). Left out on purpose by
  // the owner: brands waiting for a reply (many need none), Free Samples without proof
  // and sales (not exact). Accepted campaigns "without video" need the video list; with
  // none saved yet they are not judged.
  // ⭐ Campaigns the creator follows (25.43.0, owner's request 2026-11-11), to accept
  // them before the spots or the time run out. Colour by what is left, counting spots
  // and share together (20 left of 30 is not 20 left of 1,000): red with 20 spots or
  // fewer, under 10 % left, 3 days or less, or 10 % budget or less; yellow with 50 or
  // fewer or under 25 % left; green otherwise; "gone" once it can't be accepted.
  function watchLevel(row,now=Date.now()){
    const s=radarStatus(row||{},now);
    if(s.level==="closed") return {...s,watch:"gone"};
    const share=s.required&&s.remaining!=null?s.remaining/s.required:null;
    const red=(s.remaining!=null&&(s.remaining<=20||share<0.10))||(s.daysLeft!=null&&s.daysLeft<=3)||(s.budgetPct!=null&&s.budgetPct<=0.10);
    const yellow=s.remaining!=null&&(s.remaining<=50||share<0.25);
    return {...s,watch:red?"red":yellow?"yellow":"green"};
  }
  // What is kept of a followed campaign: page data, so only checked fields survive.
  function watchedCampaign(c,now=Date.now()){
    const id=String(c?.campaignId||"").trim();
    if(!/^[A-Za-z0-9._:-]{1,80}$/.test(id)) return null;
    const num=v=>{ const n=Number(v); return v==null||v===""||!Number.isFinite(n)?null:n; };
    const r=c.row||{};
    const asin=String(c.asin||"").toUpperCase();
    return {
      campaignId:id, adId:String(c.adId||"").slice(0,80), name:String(c.name||r.name||"").slice(0,200), brand:String(c.brand||r.brand||"").slice(0,100),
      asin:/^[A-Z0-9]{10}$/.test(asin)?asin:"", url:isCreatorConnectionsUrl(c.url)?String(c.url).slice(0,500):"",
      row:{campaignId:id,accepted:num(r.accepted),required:num(r.required),fullyClaimed:r.fullyClaimed==null?null:!!r.fullyClaimed,
        end:num(r.end),budgetLeft:num(r.budgetLeft),budgetTotal:num(r.budgetTotal)},
      addedAt:num(c.addedAt)||now, checkedAt:num(c.checkedAt)||now, gone:!!c.gone
    };
  }
  const WATCH_ORDER={red:0,yellow:1,green:2,gone:3};

  const TASK_DONE_STAGES=["CONTENIDO ENTREGADO","COLABORACIÓN FINALIZADA"];
  function buildTasks({collaborations={},videos=null,joinedAds=null,openByAsin={},watched=[],now=Date.now()}={}){
    const DAY=86400000;
    const videoAsins=new Set((videos||[]).flatMap(v=>v?.asins||[]));
    // Accepted campaigns with no content sent yet, per Amazon (owner's request 2026-11-12;
    // replaces the guess "closing in 3 days, product in no video"). The nearest end first.
    const noContent=(joinedAds||[])
      .filter(ad=>ad?.contentCount===0&&(!ad.end||ad.end>now))
      .map(ad=>({...ad,daysLeft:ad.end?Math.max(1,Math.ceil((ad.end-now)/DAY)):null}))
      .sort((a,b)=>(a.end||Infinity)-(b.end||Infinity));
    const joinedIds=new Set((joinedAds||[]).map(ad=>String(ad.campaignId)));
    const availableProducts=[...videoAsins].filter(a=>(openByAsin[a]||[]).some(c=>!joinedIds.has(String(c?.campaignId))&&(!c?.end||c.end>now))).length;
    const pending=Object.entries(collaborations||{})
      .filter(([,c])=>!TASK_DONE_STAGES.includes(c?.stage||"PENDIENTE"))
      .map(([brand,c])=>{ const at=Date.parse(c?.updatedAt||c?.createdAt||""); return {brand,stage:c?.stage||"PENDIENTE",days:Number.isFinite(at)?Math.max(0,Math.floor((now-at)/DAY)):null}; })
      .sort((a,b)=>(b.days??-1)-(a.days??-1)||a.brand.localeCompare(b.brand));
    const followed=(watched||[]).filter(c=>c?.campaignId&&!joinedIds.has(String(c.campaignId)))
      .map(c=>{ const s=watchLevel(c.row,now); return {...c,...s,watch:c.gone?"gone":s.watch}; })
      .sort((a,b)=>WATCH_ORDER[a.watch]-WATCH_ORDER[b.watch]||(a.end||Infinity)-(b.end||Infinity));
    return {noContent,availableProducts,campaignsChecked:!!videos&&Object.keys(openByAsin||{}).length>0,collaborations:pending,watched:followed,
      count:noContent.length+(availableProducts?1:0)+pending.length+followed.filter(c=>c.watch==="red"||c.watch==="yellow").length};
  }

  // Pendientes as plain text to send to the phone (beta testers' request, 2026-11-16): only
  // the sections the creator ticked. Nothing leaves the browser unless she copies or shares it.
  const TASK_SHARE_SECTIONS=["watched","noContent","videos","collaborations"];
  function tasksShareText(tasks,sections=TASK_SHARE_SECTIONS,{stageLabel=s=>tr(s),now=Date.now()}={}){
    const on=new Set(sections), n=(k,one,many)=>tr(k===1?one:many,{n:k}), out=[];
    const days=d=>d==null?"":n(d,"cierra en {n} día","cierra en {n} días");
    const add=(title,lines)=>{ if(lines.length) out.push(`${title} (${lines.length})\n${lines.map(l=>`• ${l}`).join("\n")}`); };
    if(on.has("watched")) add(tr("⭐ Campañas que sigues"),(tasks?.watched||[]).filter(c=>c.watch!=="gone").map(c=>[c.brand||tr("Marca"),c.name,c.remaining!=null?n(c.remaining,"queda {n} cupo","quedan {n} cupos"):"",days(c.daysLeft)].filter(Boolean).join(" · ")));
    if(on.has("noContent")) add(tr("📤 Campañas sin contenido"),(tasks?.noContent||[]).map(c=>[c.brand||tr("Marca"),c.name,days(c.daysLeft)].filter(Boolean).join(" · ")));
    if(on.has("videos")&&tasks?.availableProducts) out.push(`${tr("🎬 Campañas para tus videos")}\n• ${n(tasks.availableProducts,"Hay campañas disponibles en {n} producto de tus videos","Hay campañas disponibles en {n} productos de tus videos")}`);
    if(on.has("collaborations")) add(tr("📦 Colaboraciones sin terminar"),(tasks?.collaborations||[]).map(c=>[c.brand,stageLabel(c.stage),c.days==null?"":c.days===0?tr("actualizada hoy"):n(c.days,"sin cambios hace {n} día","sin cambios hace {n} días")].filter(Boolean).join(" · ")));
    const head=tr("📋 Mis pendientes en Mila.Desk · {date}",{date:new Date(now).toLocaleDateString(root.MilaI18n?.locale?.()||"es-DO")});
    return out.length?`${head}\n\n${out.join("\n\n")}`:`${head}\n\n${tr("No tengo pendientes en lo que elegí.")}`;
  }

  // 🛍️ Lo que ya compré (beta testers' request, 2026-11-16). The orders page is read in a
  // tab Mila.Desk opens for it (Amazon sends the orders encrypted and the page decrypts them,
  // so they cannot be fetched). Only ASIN, title, image and order date are kept, in memory.
  const ORDER_FILTERS=["last30","months-3","year-2026","year-2025"];
  function ordersPageUrl(filter,page=1){
    const f=ORDER_FILTERS.includes(filter)?filter:"months-3";
    return `https://www.amazon.com/your-orders/orders?timeFilter=${f}${page>1?`&page=${Math.floor(page)}`:""}`;
  }
  // One row per product: the most recent order first, with how many times it was bought.
  function mergeOrderItems(items){
    const byAsin=new Map();
    for(const it of items||[]){
      const asin=String(it?.asin||"").toUpperCase();
      if(!/^[A-Z0-9]{10}$/.test(asin)) continue;
      const prev=byAsin.get(asin);
      if(prev){ prev.times++; if(!prev.title&&it.title) prev.title=it.title; if(!prev.image&&it.image) prev.image=it.image; continue; }
      byAsin.set(asin,{asin,title:String(it.title||"").slice(0,300),image:String(it.image||""),orderDate:String(it.orderDate||"").slice(0,40),times:1});
    }
    return [...byAsin.values()];
  }

  // 🏪 Revisión de la tienda (beta testers' request, 2026-11-16): facts only. Whether a
  // product page says it is not sold now. Amazon's page text, in English or Spanish; a page
  // that does not say so counts as sold (no guess).
  function productAvailabilityFromHtml(html){
    const s=String(html||"");
    const block=(s.match(/id="availability"[\s\S]{0,1500}?<\/div>/)||[""])[0]+(s.match(/id="outOfStock"[\s\S]{0,1500}?<\/div>/)||[""])[0];
    const unavailable=/Currently unavailable|We don't know when or if this item will be back|No disponible por el momento|No sabemos cuándo/i.test(block);
    const title=((s.match(/id="productTitle"[^>]*>\s*([^<]+)/)||[])[1]||"").trim().slice(0,300);
    return {unavailable,title};
  }
  // ✍️ Títulos con IA (owner's request 2026-11-27): the «About this item» points of a product
  // page (public), so the AI writes titles with the product's real details. At most 5 × 200.
  function productBulletsFromHtml(html){
    const s=String(html||""), at=s.indexOf('id="feature-bullets"');
    if(at<0) return [];
    const text=v=>v.replace(/<[^>]*>/g," ").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&nbsp;/g," ").replace(/&[a-z#0-9]+;/gi," ").replace(/\s+/g," ").trim();
    return [...s.slice(at,at+20000).matchAll(/<span class="a-list-item">([\s\S]*?)<\/span>/g)].map(m=>text(m[1])).filter(t=>t.length>=10).slice(0,5).map(t=>t.slice(0,200));
  }
  // The ASIN of the search result that shows this picture id (Creator Hub's tag window shows
  // the product's picture and name, not its ASIN). '' when no result has that exact picture.
  function asinByImageFromSearchHtml(html,imageId){
    if(!/^[A-Za-z0-9+_-]{6,40}$/.test(String(imageId||""))) return "";
    for(const part of String(html||"").split('data-asin="').slice(1)){
      const asin=part.slice(0,10);
      if(/^[A-Z0-9]{10}"/.test(part.slice(0,11))&&part.includes("/images/I/"+imageId+".")) return asin;
    }
    return "";
  }
  // 🩺 Revisor de variantes (owner's request 2026-11-22). Since 14 Apr 2026 Amazon pays the
  // onsite commission only for the same ASIN variant (or one in the same category) as the
  // product page the video is on (Associates agreement, «What's changed»).
  // The other ASINs of a product family, from the product page (dimensionToAsinMap).
  function siblingsFromHtml(html,asin){
    const map=(String(html||"").match(/"dimensionToAsinMap"\s*:\s*\{[^}]*\}/)||[""])[0];
    return [...new Set(map.match(/\b[A-Z0-9]{10}\b/g)||[])].filter(a=>a!==asin).slice(0,60);
  }
  // Search rows (by ASIN) of campaigns that do not include that ASIN: kept small for the cache.
  const variantSearchRows=(rows,asin)=>(rows||[]).filter(c=>c?.campaignId&&!asinList(c.campaignAsins).includes(asin)).slice(0,30);
  // Open campaigns for another variant of the same product (a sibling ASIN), with that ASIN.
  function otherVariantOpen(rows,asin,siblings=[],joinedIds=new Set()){
    const family=new Set(siblings||[]), out=[];
    for(const c of rows||[]){
      const asins=asinList(c?.campaignAsins);
      if(asins.includes(asin)) continue;
      const hit=asins.find(a=>family.has(a)); if(!hit) continue;
      for(const o of toOpenOpportunities([c],hit,joinedIds)) out.push({...o,variantAsin:hit});
    }
    return out;
  }
  // What the Hospital adds for one video from the product checks (the former «Revisión de la
  // tienda»): products no longer sold, open campaigns not accepted, and campaigns that are for
  // another variant than the one tagged. Facts only; the texts are Spanish keys.
  function hospitalStoreItems({video={},products={},openByAsin={},othersByAsin={},siblingsByAsin={},joined=[],joinedIds=new Set(),now=Date.now()}={}){
    const items=[], asins=video.asins||[], tagged=new Set(asins);
    const who=a=>asins.length>1?a+": ":"";
    const add=(area,level,text)=>items.push({area,level,text});
    const pct=n=>Number(n||0).toFixed(1);
    for(const a of asins){
      const p=products[a];
      if(p?.gone) add("Producto","grave",tr("{who}La página del producto ya no existe: este video ya no puede salir ahí.",{who:who(a)}));
      else if(p?.unavailable) add("Producto","leve",tr("{who}Amazon dice que no está disponible por el momento.",{who:who(a)}));
      for(const c of (openByAsin[a]||[]).filter(c=>!joinedIds.has(String(c.campaignId))&&(!c.end||c.end>now)))
        add("Campañas","nota",tr("{who}Campaña abierta sin aceptar: {brand} +{pct} %.",{who:who(a),brand:c.brand||tr("Marca"),pct:pct(c.ratePercent)}));
      const family=new Set(siblingsByAsin[a]||[]);
      // An accepted campaign that covers a sibling but none of the tagged ASINs.
      for(const ad of joined||[]){
        const list=Array.isArray(ad?.asins)?ad.asins:[];
        if(list.some(x=>tagged.has(x))||(ad.end&&ad.end<now)) continue;
        const other=list.find(x=>family.has(x)); if(!other) continue;
        add("Variantes","grave",tr("{who}Tu campaña aceptada de {brand} es de otra variante ({other}), no de la que etiquetaste. Amazon paga la comisión on-site solo por la misma variante: etiqueta también {other} en este video.",{who:who(a),brand:ad.brand||tr("Marca"),other}));
      }
      for(const c of othersByAsin[a]||[]){
        if(tagged.has(c.variantAsin)||(c.end&&c.end<now)) continue;
        add("Variantes","leve",tr("{who}Hay una campaña de {brand} (+{pct} %) para otra variante ({other}): si etiquetas esa variante en el video, puedes aceptarla.",{who:who(a),brand:c.brand||tr("Marca"),pct:pct(c.ratePercent),other:c.variantAsin}));
      }
    }
    const seen=new Set();
    return items.filter(i=>!seen.has(i.text)&&seen.add(i.text));
  }
  // Which list each video goes in. Each video can be in several.
  function storeReviewGroups(video,products={},openByAsin={},joinedIds=new Set(),now=Date.now()){
    const out=[], asins=video?.asins||[];
    const state=String(video?.state||"").toUpperCase();
    if(state&&state!=="LIVE") out.push("rejected");
    if(!asins.length) out.push("untagged");
    if(asins.some(a=>products[a]&&(products[a].gone||products[a].unavailable))) out.push("discontinued");
    if(asins.some(a=>(openByAsin[a]||[]).some(c=>!joinedIds.has(String(c.campaignId))&&(!c.end||c.end>now)))) out.push("campaign");
    return out;
  }

  // 🪪 Media kit (owner's authorization 2026-11-17). What the creator writes is cut to known
  // fields and sizes before it is saved; the public page draws it again with textContent.
  const MEDIA_KIT_NETWORKS=Object.freeze({
    instagram:/^https:\/\/(www\.)?instagram\.com\//i, tiktok:/^https:\/\/(www\.)?tiktok\.com\//i,
    youtube:/^https:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//i, pinterest:/^https:\/\/([a-z]{2,3}\.|www\.)?pinterest\.[a-z.]{2,6}\//i,
    facebook:/^https:\/\/(www\.|m\.)?facebook\.com\//i, storefront:/^https:\/\/www\.amazon\.com\/shop\//i
  });
  const MEDIA_KIT_MAX_VIDEOS=8;
  // The profile photo of the creator's storefront (amazon.com/shop/<handle>), seen 2026-11-17.
  function storefrontPhotoFromHtml(html){
    const tag=(String(html||"").match(/<img[^>]*id="shop-influencer-profile-header-image"[^>]*>/)||String(html||"").match(/<img[^>]*alt="Influencer's Profile Image"[^>]*>/)||[""])[0];
    const src=(tag.match(/src="([^"]+)"/)||[])[1]||"";
    return /^https:\/\/m\.media-amazon\.com\/images\/[\w%./+,-]{1,300}$/.test(src)?src:"";
  }
  function mediaKitSlug(text){
    return String(text||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,30).replace(/-+$/,"");
  }
  const isMediaKitSlug=s=>/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(String(s||""));
  // The metrics proof the creator uploaded (the file is in Storage; this is only its label).
  const MEDIA_KIT_PROOF_TYPES=["application/pdf","image/png","image/jpeg","image/webp"];
  const MEDIA_KIT_PROOF_MAX=5*1024*1024;
  function mediaKitProof(p){
    if(!p||typeof p!=="object"||!MEDIA_KIT_PROOF_TYPES.includes(p.type)) return null;
    const at=Math.floor(Number(p.at));
    return {type:p.type,name:String(p.name??"").replace(/[\u0000-\u001f\u007f]/g," ").trim().slice(0,120),at:Number.isFinite(at)&&at>0?at:null};
  }
  // The real type of an uploaded file from its first bytes (never from its name or what the
  // browser claims): PDF, PNG, JPEG or WebP; anything else is refused.
  function mediaKitProofType(bytes){
    const b=bytes||[], at=(i,list)=>list.every((v,j)=>b[i+j]===v);
    if(at(0,[0x25,0x50,0x44,0x46,0x2d])) return "application/pdf";
    if(at(0,[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])) return "image/png";
    if(at(0,[0xff,0xd8,0xff])) return "image/jpeg";
    if(at(0,[0x52,0x49,0x46,0x46])&&at(8,[0x57,0x45,0x42,0x50])) return "image/webp";
    return "";
  }
  function cleanMediaKit(input){
    const d=input&&typeof input==="object"?input:{};
    const txt=(v,max)=>String(v??"").replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim().slice(0,max);
    const num=v=>{ const n=Math.floor(Number(v)); return Number.isFinite(n)&&n>=0&&n<1e10?n:null; };
    const links={}, followers={};
    for(const [k,re] of Object.entries(MEDIA_KIT_NETWORKS)){
      const url=txt(d.links?.[k],200);
      if(url&&re.test(url)) links[k]=url;
      const f=num(d.followers?.[k]); if(f!=null&&k!=="storefront") followers[k]=f;
    }
    const isEmail=v=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)?v:"", phoneTxt=v=>txt(v,24).replace(/[^\d+ ]/g,"");
    const email=txt(d.contact?.email,120), whatsapp=phoneTxt(d.contact?.whatsapp), phone=phoneTxt(d.contact?.phone);
    const st=d.stats&&typeof d.stats==="object"?d.stats:null;
    const stats=st?{at:num(st.at),videos:num(st.videos),views:num(st.views),pctViewed:st.pctViewed==null?null:Math.max(0,Math.min(100,Math.round(Number(st.pctViewed)||0))),campaigns:num(st.campaigns),collabsDone:num(st.collabsDone)}:null;
    const amazonImage=u=>/^https:\/\/m\.media-amazon\.com\/images\/[\w%./+,-]{1,300}$/.test(String(u||""))?String(u):"";
    const top=(Array.isArray(d.top)?d.top:[]).slice(0,MEDIA_KIT_MAX_VIDEOS).map(v=>({title:txt(v?.title,140),views:num(v?.views),
      thumb:amazonImage(v?.thumb),
      url:/^https:\/\/www\.amazon\.com\/shop\/[\w.-]+\/video\/[\w.-]+/i.test(String(v?.url||""))?String(v.url).slice(0,300):""})).filter(v=>v.url||v.title);
    const show=d.show&&typeof d.show==="object"?d.show:{};
    // Contact: each one shown or not (25.52: was one "show my contact" for all, kept as default).
    const contactOn=k=>show[k]!=null?show[k]!==false:show.contact!==false;
    // Shipping address (owner, 2026-11-17): kept only while she accepted showing it (the
    // public warning), so a hidden address is never stored with the public kit.
    const a=d.address&&typeof d.address==="object"?d.address:{};
    const address=show.address===true?{name:txt(a.name,80),line1:txt(a.line1,100),line2:txt(a.line2,100),city:txt(a.city,60),state:txt(a.state,40),zip:txt(a.zip,12),
      phone:phoneTxt(a.phone),email:isEmail(txt(a.email,120))}:null;
    const addressOn=!!(address&&address.line1);
    return {name:txt(d.name,80),photo:amazonImage(d.photo),tagline:txt(d.tagline,600),topics:(Array.isArray(d.topics)?d.topics:String(d.topics||"").split(",")).map(t=>txt(t,30)).filter(Boolean).slice(0,8),
      links,followers,contact:{email:isEmail(email),whatsapp,phone},rates:txt(d.rates,600),
      address:addressOn?address:null,addressAcceptedAt:addressOn?num(d.addressAcceptedAt):null,
      lang:d.lang==="en"?"en":"es",stats,top,proof:mediaKitProof(d.proof),
      theme:{accent:/^#[0-9a-f]{6}$/i.test(String(d.theme?.accent||""))?String(d.theme.accent).toLowerCase():"#ff6a1a",bg:d.theme?.bg==="light"?"light":"dark"},
      show:{stats:show.stats!==false,videos:show.videos!==false,email:contactOn("email"),whatsapp:contactOn("whatsapp"),phone:contactOn("phone"),
        rates:show.rates===true,followers:show.followers!==false,proof:show.proof===true,address:addressOn}};
  }
  // The numbers Mila.Desk reads from Amazon for the kit: published videos, their views and
  // average % watched (weighted by views), the most watched, campaigns accepted.
  function mediaKitStats({videos=[],handle="",joinedCount=null,collabsDone=null,now=Date.now()}={}){
    const live=(videos||[]).filter(v=>!v.state||String(v.state).toUpperCase()==="LIVE");
    const withViews=live.filter(v=>Number(v.views)>0);
    const views=withViews.reduce((a,v)=>a+Number(v.views),0);
    const pctRows=withViews.filter(v=>v.pctViewed!=null&&Number.isFinite(Number(v.pctViewed)));
    const pctBase=pctRows.reduce((a,v)=>a+Number(v.views),0);
    const pct=pctBase?pctRows.reduce((a,v)=>a+Number(v.pctViewed)*Number(v.views),0)/pctBase:null;
    // Every published video, most viewed first (the creator picks up to 8; the 8 first by default).
    const choices=live.slice().sort((a,b)=>(Number(b.views)||0)-(Number(a.views)||0)).slice(0,120)
      .map(v=>({aci:v.aci,title:v.title||"",views:Number(v.views)||0,thumb:v.thumb||"",url:handle?storefrontVideoUrl(handle,v.aci):""})).filter(v=>v.url);
    const top=choices.slice(0,MEDIA_KIT_MAX_VIDEOS);
    return {stats:{at:now,videos:live.length,views,pctViewed:pct==null?null:Math.round(pct),campaigns:joinedCount,collabsDone},top,choices,
      storefront:handle?`https://www.amazon.com/shop/${handle}`:""};
  }

  // Creator username from Amazon (25.41.0, owner's request 2026-11-10). The Associates
  // home page links the creator's storefront (amazon.com/shop/<handle>) and affiliate ID,
  // which do not change when the creator renames themselves in Creator Connections (that
  // display name comes from /connect/api/creators and can change). Seen on the owner's
  // account on 2026-11-10. Returns "" when the page has neither (no storefront).
  function creatorHandleFromHtml(html){
    const s=String(html||"");
    const m=s.match(/amazon\.[a-z.]{2,8}\/shop\/([A-Za-z0-9._-]{2,40})(?=[/?"'&#\\]|$)/)||s.match(/affiliateId(?:=|%3D)([A-Za-z0-9._-]{2,40})(?=[&"'#\\]|$)/);
    return m?m[1]:"";
  }

  // Amazon gives every new storefront a default handle ("influencer-e8cf5a08") until the
  // creator picks one. For those, the username is the storefront's public name instead
  // (owner's request, 2026-11-13).
  const isDefaultCreatorHandle=h=>/^influencer-[0-9a-f]{6,12}$/i.test(String(h||"").trim());
  function storefrontNameFromHtml(html){
    const s=String(html||"");
    const decode=v=>v.replace(/\\u([0-9a-f]{4})/gi,(_,x)=>String.fromCharCode(parseInt(x,16))).replace(/&#39;|&#x27;/gi,"'").replace(/&quot;/gi,'"').replace(/&amp;/gi,"&");
    const raw=(s.match(/\\?"publicName\\?"\s*:\s*\\?"((?:[^"\\]|\\u[0-9a-fA-F]{4}){1,80})\\?"/)||[])[1]
      ??(s.match(/<title>\s*Página de Amazon de ([^<]{1,80}?)\s*<\/title>/i)||[])[1]
      ??(s.match(/<title>\s*([^<]{1,80}?)(?:&#39;|')s Amazon Page\s*<\/title>/i)||[])[1]
      ??"";
    return decode(raw).replace(/[\u0000-\u001f<>]/g,"").replace(/\s+/g," ").trim().slice(0,40);
  }

  // What's new (25.40.0, owner's request 2026-11-10). One entry per version with
  // something to tell, newest first, in Spanish (translations in lib/i18n.js). A small
  // fix with nothing to tell gets no entry, so it shows nothing.
  const RELEASE_NOTES=Object.freeze([
    {version:"25.54.0",items:["✨ Títulos con IA en Creator Hub: junto a «Título», Mila.Desk te propone 5 títulos de 60 caracteres o menos para tu video, con tu estilo y los datos del producto etiquetado. Para suscripciones pagadas.",
      "🏷️ Etiquetar productos: junto a «Buscar en Amazon» salen tus campañas aceptadas con todos sus productos, y «Usar este ASIN» lo busca por ti.",
      "🩺 Hospital de videos: te dice cuántas veces sale cada video («Sale en X de cada 10 visitas»), marca en amarillo los que salen poco y trae una revisión semanal con IA que te dice qué cambiar primero (para suscripciones pagadas). Ya no muestra borradores.",
      "✉️ Radar: en las campañas grises (cupo completo) ahora puedes escribir a la marca, ver el producto o abrir la campaña.",
      "📨 Mensajes a marcas: cada campaña muestra la foto y el nombre de su producto.",
      "🧰 Kit Premium: una barra para pasar de una herramienta a otra. Pinterest llega pronto.",
      "⬇ Descargar mis videos: marca los que quieras o «Descargar todos», en un solo ZIP o uno por uno a tu carpeta de Descargas.",
      "🎟️ Panel de mentoras e influencers: al copiar un código queda tachado al final de la lista; si la persona no lo usó, lo vuelves a poner disponible.",
      "💳 Si usaste un código con tarjeta y te falta ponerla, Mila.Desk te muestra los pasos para terminar. Si no te llegó el correo de confirmación, ahora puedes pedir otro.",
      "🔧 Arreglos: el Hospital y el panel de afiliada abren bien, y el análisis completo de conversaciones tiene más espacio para guardarse."]},
    {version:"25.53.1",items:["🎯 Galería y carrusel más exactos: Amazon muestra solo una parte de los videos en cada visita, así que Mila.Desk ahora revisa varias veces antes de decir que tu video no aparece."]},
    {version:"25.53.0",items:["🩺 Hospital de videos: revisa todos tus videos y te dice cuáles muestra Amazon (en verde) y cuáles no salen ni en la galería ni en el carrusel (en rojo). También te avisa si tu video está en otra variante que la de tu campaña.",
      "🚫 Marcas tachadas: tacha las marcas que no envían muestras o que no responden. Salen tachadas en el Radar y en tus campañas, y nunca reciben mensajes masivos.",
      "💡 Sugerencias: si en un chat una marca dice que no envía muestras, Mila.Desk te sugiere tacharla en Mensajes a marcas.",
      "🔥 Nota del 1 al 10: «¿Vale la pena grabar?» ahora le pone nota a cada producto, en su página y en «Lo que ya compré».",
      "⏸️ Ventas: «¿Qué se vendió?» se apaga por ahora, mientras lo mejoramos."]},
    {version:"25.52.0",items:["🪪 Media kit: arma tu página para marcas con tus números, tus mejores videos, tus tarifas y tu contacto, y compártela con un enlace. Tú eliges qué se muestra.",
      "🤔 En la página de un producto, «¿Vale la pena grabar?» te dice cuántos influencers ya tienen video, sus ventas del mes, el ranking y si hay campaña.",
      "⬇ Kit de trabajo: descarga tus videos publicados en MP4, la revisión de tu tienda y «Lo que ya compré» con campaña abierta.",
      "🎁 Free Samples: filtro «Solo marcas con campañas disponibles».",
      "🔧 Vuelve el botón «＋ Colaboración» en el chat de Mensajes (Amazon cambió la página)."]},
    {version:"25.51.0",items:["📦 Colaboraciones: nuevo estado «Por responder», para las marcas que vas a contestar más tarde.",
      "🎬 Campañas de mis videos: los videos que ya enviaste salen de la lista y hay un botón «↻ Actualizar».",
      "🎁 Free Samples: cada marca dice cuántas campañas tiene disponibles."]},
    {version:"25.50.0",items:["☁️ Tu historial de Mensajes a marcas, la lista de Insistir, tus mensajes guardados, tus plantillas y tus datos de Ventas ahora tienen copia en la nube: no se pierden si cambias de computadora."]},
    {version:"25.49.0",items:["📌 En la página de una campaña, el Radar tiene «📌 Insistir a esta marca»: la marca pasa a la lista de Insistir de Mensajes a marcas."]},
    {version:"25.48.0",items:["📤 Campañas de mis videos: envía tu video a las campañas aceptadas que aún no tienen contenido, con un botón, y si quieres avísale a la marca. Nada se envía sin tu clic."]},
    {version:"25.47.0",items:["📌 Mensajes a marcas: marca con 📌 las marcas que no te responden, revisa si ya te contestaron y vuelve a escribirles una vez por semana. Las marcas ahora se cargan de 100 en 100."]},
    {version:"25.46.0",items:["📨 Mensajes a marcas: busca marcas con campañas abiertas por categoría y envíales tu mensaje con un botón. Mila.Desk te avisa con cuáles ya hablaste."]},
    {version:"25.45.0",items:["📋 ⑤ TAREAS ahora se llama ⑤ PENDIENTES.","📤 Pendientes muestra tus campañas aceptadas a las que todavía no les enviaste contenido, con los días que les quedan."]},
    {version:"25.44.0",items:["✅ «Campañas de mis videos»: marca las campañas disponibles y acéptalas todas con un botón, sin ir una por una. Nada se acepta sin tu clic.","🔆 Las campañas disponibles se ven mucho más en Video Intelligence, y en «Campañas de mis videos» los videos con campaña disponible salen primero.","⚙️ Configuración más ordenada: tu cuenta y tu usuario en un solo cajón, lo que más usas arriba y el respaldo de datos junto al final."]},
    {version:"25.43.0",items:["⭐ Sigue campañas desde el Radar: en ⑤ Tareas ves cuántos cupos les quedan, con un color que avisa cuando se están acabando. Se guardan en tu cuenta.","＋ En Free Samples puedes agregar varias marcas de tus colaboraciones de una vez."]},
    {version:"25.42.0",items:["✅ ⑤ TAREAS: tus campañas aceptadas que cierran pronto sin video, las campañas disponibles para tus videos y tus colaboraciones sin terminar, en una sola lista."]},
    {version:"25.41.0",items:["👤 Tu usuario de Mila.Desk se toma de tu cuenta de Amazon (el de tu tienda) y ya no depende del nombre que pongas en Creator Connections."]},
    {version:"25.40.0",items:["🆕 Novedades: después de cada actualización verás aquí qué cambió. Para volver a verlas, pulsa «🆕 Novedades» abajo del todo."]},
    {version:"25.39.0",items:["📊 «¿Qué se vendió?» tiene su propia página: ábrela con el botón que aparece en tus informes de Amazon.","Ventas recuerda más productos, así identifica más ventas.","Ventas muestra lo que ganaste cada día con Creator Connections."]},
    {version:"25.38.0",items:["＋ Guardar en el chat: guarda como mensaje rápido lo que escribiste en el cuadro.","🎬 Campañas de mis videos: tus videos con sus campañas de Creator Connections.","🎛 Funciones en Amazon: enciende o apaga cada cosa que Mila.Desk muestra en Amazon.","✕ Ahora puedes cancelar un análisis."]},
    {version:"25.37.0",items:["Suscripción Premium con Paddle."]},
    {version:"25.36.0",items:["🌐 Mila.Desk en inglés: elige el idioma en Configuración."]}
  ]);
  function compareVersions(a,b){
    const pa=String(a||"").split(".").map(n=>parseInt(n,10)||0), pb=String(b||"").split(".").map(n=>parseInt(n,10)||0);
    for(let i=0;i<Math.max(pa.length,pb.length);i++){ const d=(pa[i]||0)-(pb[i]||0); if(d) return d>0?1:-1; }
    return 0;
  }
  // Notes newer than lastSeen, up to the installed version. No lastSeen → nothing
  // (a new install sets it to the installed version, so it never sees old notes).
  function releaseNotesSince(lastSeen,current,notes=RELEASE_NOTES){
    if(!lastSeen) return [];
    return notes.filter(n=>compareVersions(n.version,lastSeen)>0&&compareVersions(n.version,current)<=0);
  }
  // One note as a card for the Novedades poster (owner's request 2026-11-21): the leading
  // emoji is the icon and a short part before ":" is the title ("🪪 Media kit: arma…").
  function releaseNoteParts(text){
    let s=String(text||"").trim(), icon="✨", title="";
    const m=s.match(/^([^\p{L}\p{N}\s«"(¿¡]+)\s+(.+)$/su); if(m){ icon=m[1]; s=m[2]; }
    const c=s.indexOf(": "); if(c>0&&c<=40){ title=s.slice(0,c); s=s.slice(c+2); s=s.charAt(0).toUpperCase()+s.slice(1); }
    return {icon,title,text:s};
  }

  // 📌 Pinterest shows as «Próximamente» (owner's request 2026-11-26): the button and the Kit bar
  // show it with the tag and the page explains what is coming. false = the tool opens.
  const PINTEREST_SOON=true;
  root.MilaCore=Object.freeze({
    PINTEREST_SOON,
    RELEASE_NOTES,compareVersions,PRESENCE_EVERY_MIN,PRESENCE_ONLINE_MIN,presenceSummary,presenceStart,amazonLinkMessage,releaseNotesSince,releaseNoteParts,creatorHandleFromHtml,isDefaultCreatorHandle,storefrontNameFromHtml,buildTasks,TASK_DONE_STAGES,tasksShareText,ORDER_FILTERS,ordersPageUrl,mergeOrderItems,presenceAdd,presenceStats,presenceText,presenceSplit,presenceChangeText,titleLogUpdate,productAvailabilityFromHtml,productBulletsFromHtml,asinByImageFromSearchHtml,storeReviewGroups,MEDIA_KIT_NETWORKS,MEDIA_KIT_MAX_VIDEOS,storefrontPhotoFromHtml,mediaKitSlug,isMediaKitSlug,cleanMediaKit,mediaKitStats,videoHlsFromHtml,storefrontVideoItems,hlsBestVariant,hlsSegments,videoFileName,MEDIA_KIT_PROOF_TYPES,MEDIA_KIT_PROOF_MAX,mediaKitProofType,TASK_SHARE_SECTIONS,watchLevel,watchedCampaign,campaignAcceptBody,
    decodeBase64Loose,extractEntityId,conversationStorageKey,analyzeContextToken,summarizeKeyDiagnostics,
    buildEntityKeyMap,resolveStorageKey,dedupeResultsByEntity,mergeCloudAndLocalResults,
    lastMessageIso,buildEntityIndex,needsAnalysis,groupRowsByColumns,runPool,
    buildConversationUpsertRow,shouldSyncResult,isRetryableStatus,retryAsync,paginateConversationIndex,
    dedupeByContextToken,USER_BOUND_LOCAL_KEYS,filterBackupData,filterRestoreData,ACTIVE_ANALYSIS_STATES,
    isAnalysisActive,analysisStatusLabel,analysisFinishedLabel,chunk,
    formatMoney,formatRevenueFloor,estimateMonthlyRevenue,placementUnverifiedReason,
    parseAmazonPrice,addPriceObservation,summarizePriceHistory,formatPriceHistory,formatShortDateEs,
    isCreatorVideoId,isBrandVideoId,isProductVideoId,parseRelatedVideosHtml,extractCarouselIds,sampleVideoIds,parseRelatedVideoCards,summarizeVideoPool,parseBestSellersRank,
    computeVideoPlacement,placementContextNote,recordAdvice,
    onsiteRateRange,formatPercentEs,formatOnsiteCommission,
    createPacer,amazonRequestClass,walkTokenPages,toJoinedCampaign,uniqueBy,campaignSearchRows,
    toOpenOpportunities,matchJoinedCampaigns,chooseProductCampaign,parseBoughtBadge,formatBoughtLabel,
    mergeDemandObservation,
    toRadarRow,extractRadarRows,mergeRadarRow,radarFromDetailText,formatBudgetShort,normalizeBrand,freeSampleBrandSet,freeSampleCampaignUrl,SAMPLE_CATEGORIES,knownSampleCategories,brandCategoryNodes,sampleCategoryNames,sampleCategoryOptions,matchesSampleCategory,uniqueBrandNames,freeSampleDuplicate,conversationPositionHint,staleViCacheKeys,radarKey,radarStatus,
    SAVED_MESSAGE_LIMITS,ADDRESS_MESSAGE_ID,defaultSavedMessages,normalizeSavedMessages,fillMessageTemplate,savedMessageParts,tooLongParts,
    storefrontVideoUrl,creatorEditUrl,isStorefrontVideoUrl,videoSubmissions,BACKUP_DOCS,BACKUP_ALWAYS_MERGE,BACKUP_MAX_BYTES,mergeBackupDoc,backupSize,
    OUTREACH_LIMITS,outreachBrandRows,asinInfoBody,asinInfoProducts,affiliateLink,asinFromText,shortProductName,pinTexts,outreachLabel,outreachAnalysisMap,outreachParts,outreachSendOk,outreachChat,addOutreachHistory,
    recordScore,siblingsFromHtml,variantSearchRows,otherVariantOpen,hospitalStoreItems,saysNoSamples,noSampleSuggestions,BLOCK_REASONS,addBlockedBrand,blockedEntry,blockedReasonText,FOLLOW_UP_DAYS,FOLLOW_UP_NO_REPLY,outreachNextAllowed,outreachTooSoon,addFollowUp,followUpView,brandAnsweredLast,
    CODE_BATCH_LIMIT,groupBetaCodes,codeBatchCsv,mentorStudentState,mentorSummary,mentorFreeYearEnd,firstPaidCharge,earningsSummary,earningsCsv,mentorCommissions,commissionRate,mentorRateNow,freeDaysLeft,partnerActivity,
    ORIGIN,ACCESS_PLAN_LABELS,normalizeAccess,describeAccess,accessPlanLabel,profileInitial,identifiedSalesDays,redeemMessage,FEEDBACK_LIMITS,feedbackBrowser,feedbackCheck,feedbackMessage,
    COLLAB_STAGES,findCollaborationKey,parseReportMoney,parseSalesRow,mergeSalesDays,normalizeCcDays,mergeCcDays,withCcEarnings,salesCatalog,salesProductsKey,SALES_PANEL_ENABLED,parseLinkedProductRow,salesLinkedKey,keepLinkedProducts,ownSalesCatalog,keepSalesProducts,salesProductFromFacts,addSalesProducts,pricesForDate,deduceDaySales,isConversationListMarker,isCreatorConnectionsUrl,pickConversationTab,ANALYSIS_SNAPSHOT_KEYS,cancelledAnalysisState,FEATURE_SWITCHES,normalizeFeatures,videoCoverUrl,videoDurationSecs,videoCoverStats,videoHealth,acceptedCampaignUrl,campaignIdFromUrl,sameBrand,acceptedCampaignsForBrand,mergeAcceptedCampaigns,unlinkedAcceptedCampaigns,campaignLabel
  });
})(typeof globalThis!=="undefined"?globalThis:self);
