/* =========================================================
   薬局シフト管理システム MVP
   データ層：localStorage（将来 JSONBin / Firebase へ移行しやすいよう分離）
   ========================================================= */

const STORAGE_KEY = "pharmacyShiftDB_v1";
const WEEKDAYS = ["日","月","火","水","木","金","土"];

/* ---------- データアクセス層 ---------- */
const DB = {
  load(){
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw){ return JSON.parse(raw); }
    const seed = seedData();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
    return seed;
  },
  save(data){
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }
};

function uid(prefix){
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
}

/* ---------- 初期シードデータ（添付シフト表を参考） ---------- */
function seedData(){
  const stores = [
    {id:"s1", name:"ひまわり",   amNeed:1, pmNeed:1, memo:""},
    {id:"s2", name:"アイリス",   amNeed:1, pmNeed:1, memo:""},
    {id:"s3", name:"加納岩",     amNeed:3, pmNeed:3, memo:""},
    {id:"s4", name:"竜王",       amNeed:1, pmNeed:1, memo:""},
    {id:"s5", name:"韮崎",       amNeed:1, pmNeed:1, memo:""},
    {id:"s6", name:"新店舗（店舗名を編集してください）", amNeed:1, pmNeed:1, memo:"6店舗目。店舗管理画面で名称・必要人数を編集してください。"}
  ];

  const staffRaw = [
    ["川口 祐樹","s1"], ["前島 正人","s1"], ["川口 文美","s1"],
    ["鈴木 一慶","s2"], ["藤原 祐輔","s2"],
    ["小倉 慎也","s3"], ["村田 由紀子","s3"], ["前田 光太郎","s3"], ["中沢 美紀","s3"],
    ["沖津 千恵","s3"], ["原 美香","s3"], ["小菅 明子","s3"], ["竹川 健一","s3"], ["三枝 賢治","s3"],
    ["清水 洋子","s4"], ["水野 愛","s4"],
    ["中山 香代子","s5"], ["櫻井 公子","s5"], ["小林 奈美","s5"]
  ];

  const storeNameById = Object.fromEntries(stores.map(s=>[s.id,s.name]));
  const staff = staffRaw.map(([name, baseStore])=>({
    id: uid("st"),
    name,
    qualification: "",
    homeStore: storeNameById[baseStore],
    baseStore,
    baseOffDays: [0], // 日曜休みを基本とする（画像の傾向を簡易反映）
    wageType: "hourly",
    wage: 0,
    memo: "初期データは画像から自動取込。基本パターン画面で実際の勤務に合わせて調整してください。"
  }));

  // 基本パターン：休み曜日以外は基本勤務店舗で終日勤務
  const patterns = {};
  staff.forEach(st=>{
    patterns[st.id] = WEEKDAYS.map((_, wd)=>{
      if(st.baseOffDays.includes(wd)){
        return {am:null, pm:null};
      }
      return {am: st.baseStore, pm: st.baseStore};
    });
  });

  return {
    stores,
    staff,
    patterns,     // { staffId: [ {am,pm} x7 (日~土) ] }
    shifts: {},   // { "YYYY-MM": { assignments:[{id,date,shift,storeId,staffId}], finalized:bool } }
    requests: []  // 希望休・調整申請
  };
}

let db = DB.load();

/* ---------- 共通ユーティリティ ---------- */
function getStore(id){ return db.stores.find(s=>s.id===id); }
function getStaff(id){ return db.staff.find(s=>s.id===id); }

function getMonthDates(ym){
  // ym = "YYYY-MM"
  const [y,m] = ym.split("-").map(Number);
  const days = new Date(y, m, 0).getDate();
  const list = [];
  for(let d=1; d<=days; d++){
    const date = new Date(y, m-1, d);
    const iso = `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    list.push({iso, day:d, weekday: date.getDay()});
  }
  return list;
}

function currentMonthStr(){
  const now = new Date(2026,5,22); // 基準日：2026-06-22
  // 画像のシフト対象（6/21〜7/20）に合わせ、デフォルトは2026-07
  return "2026-07";
}

function ensureShift(ym){
  if(!db.shifts[ym]) db.shifts[ym] = {assignments:[], finalized:false};
  return db.shifts[ym];
}

/* =========================================================
   タブ切り替え
   ========================================================= */
document.getElementById("tabNav").addEventListener("click", (e)=>{
  const btn = e.target.closest(".tab-btn");
  if(!btn) return;
  document.querySelectorAll(".tab-btn").forEach(b=>b.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach(p=>p.classList.remove("active"));
  btn.classList.add("active");
  document.getElementById("tab-"+btn.dataset.tab).classList.add("active");
  if(btn.dataset.tab==="dashboard") renderDashboard();
  if(btn.dataset.tab==="staff") renderStaffTab();
  if(btn.dataset.tab==="stores") renderStoresTab();
  if(btn.dataset.tab==="pattern") renderPatternTab();
  if(btn.dataset.tab==="calendar") renderCalendarTab();
  if(btn.dataset.tab==="requests") renderRequestsTab();
});

/* =========================================================
   1. 代表者管理画面（月間シフト）
   ========================================================= */
const shiftMonthInput = document.getElementById("shiftMonth");
const storeFilterSelect = document.getElementById("storeFilter");
shiftMonthInput.value = currentMonthStr();

function fillStoreFilter(){
  storeFilterSelect.innerHTML = `<option value="all">すべての店舗</option>` +
    db.stores.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
}

function renderDashboard(){
  fillStoreFilter();
  const ym = shiftMonthInput.value || currentMonthStr();
  const shift = db.shifts[ym];
  document.getElementById("finalizedBadge").hidden = !(shift && shift.finalized);
  renderShiftTable(ym);
  renderShortageBox(ym);
  renderStaffStats(ym);
}

function renderShiftTable(ym){
  const tableEl = document.getElementById("shiftTable");
  const shift = ensureShift(ym);
  const dates = getMonthDates(ym);
  const filter = storeFilterSelect.value;
  const stores = filter==="all" ? db.stores : db.stores.filter(s=>s.id===filter);

  let thead = `<thead><tr><th class="store-col">店舗 / 区分</th>`;
  dates.forEach(d=>{
    const cls = d.weekday===0 ? "weekend-col" : d.weekday===6 ? "weekend-col" : "";
    thead += `<th class="${cls}">${d.day}<br>(${WEEKDAYS[d.weekday]})</th>`;
  });
  thead += `</tr></thead>`;

  let tbody = "<tbody>";
  stores.forEach(store=>{
    ["AM","PM"].forEach(sh=>{
      tbody += `<tr><td class="store-col">${escapeHtml(store.name)}<br><span style="font-size:10px;color:#888;">${sh==="AM"?"午前":"午後"}</span></td>`;
      dates.forEach(d=>{
        const assigned = shift.assignments.filter(a=>a.date===d.iso && a.storeId===store.id && a.shift===sh);
        const need = sh==="AM" ? store.amNeed : store.pmNeed;
        const short = assigned.length < need;
        tbody += `<td class="cell-day ${short?"shortage":""}" data-date="${d.iso}" data-store="${store.id}" data-shift="${sh}">`;
        tbody += `<div class="cell-count ${short?"short":""}">${assigned.length}/${need}</div>`;
        assigned.forEach(a=>{
          const st = getStaff(a.staffId);
          tbody += `<span class="cell-chip">${st?escapeHtml(st.name):"?"}<button class="chip-remove" data-aid="${a.id}">×</button></span>`;
        });
        tbody += renderAddSelect(store.id, sh, d.iso);
        tbody += `</td>`;
      });
      tbody += `</tr>`;
    });
  });
  tbody += "</tbody>";
  tableEl.innerHTML = thead + tbody;
}

function renderAddSelect(storeId, shift, dateIso){
  const options = db.staff.map(st=>`<option value="${st.id}">${escapeHtml(st.name)}</option>`).join("");
  return `<select class="cell-add-select" data-date="${dateIso}" data-store="${storeId}" data-shift="${shift}">
    <option value="">＋追加...</option>${options}
  </select>`;
}

document.getElementById("shiftTable").addEventListener("click", (e)=>{
  const btn = e.target.closest(".chip-remove");
  if(!btn) return;
  const ym = shiftMonthInput.value;
  const shift = ensureShift(ym);
  if(shift.finalized){ alert("このシフトは確定済みです。編集するには確定を解除してください。"); return; }
  shift.assignments = shift.assignments.filter(a=>a.id!==btn.dataset.aid);
  DB.save(db);
  renderDashboard();
});

document.getElementById("shiftTable").addEventListener("change", (e)=>{
  const sel = e.target.closest(".cell-add-select");
  if(!sel || !sel.value) return;
  const ym = shiftMonthInput.value;
  const shift = ensureShift(ym);
  if(shift.finalized){ alert("このシフトは確定済みです。編集するには確定を解除してください。"); return; }
  const {date, store, shift:sh} = sel.dataset;
  const dup = shift.assignments.some(a=>a.date===date && a.storeId===store && a.shift===sh && a.staffId===sel.value);
  if(dup){ alert("すでに同じ枠に登録されています。"); return; }
  shift.assignments.push({id:uid("a"), date, shift:sh, storeId:store, staffId:sel.value});
  DB.save(db);
  renderDashboard();
});

storeFilterSelect.addEventListener("change", ()=>renderShiftTable(shiftMonthInput.value));
shiftMonthInput.addEventListener("change", renderDashboard);

document.getElementById("btnGenerate").addEventListener("click", ()=>{
  const ym = shiftMonthInput.value;
  if(!ym){ alert("対象月を選択してください。"); return; }
  const existing = db.shifts[ym];
  if(existing && existing.assignments.length){
    if(!confirm("この月の仮シフトは既に存在します。基本パターンから再生成し、現在の内容を上書きします。よろしいですか？")) return;
  }
  const dates = getMonthDates(ym);
  const assignments = [];
  db.staff.forEach(st=>{
    const pattern = db.patterns[st.id] || [];
    dates.forEach(d=>{
      const rule = pattern[d.weekday];
      if(!rule) return;
      if(rule.am){ assignments.push({id:uid("a"), date:d.iso, shift:"AM", storeId:rule.am, staffId:st.id}); }
      if(rule.pm){ assignments.push({id:uid("a"), date:d.iso, shift:"PM", storeId:rule.pm, staffId:st.id}); }
    });
  });
  db.shifts[ym] = {assignments, finalized:false};
  DB.save(db);
  renderDashboard();
  alert("基本パターンから仮シフトを生成しました。内容を確認し、必要に応じて手動で調整してください。");
});

document.getElementById("btnFinalize").addEventListener("click", ()=>{
  const ym = shiftMonthInput.value;
  const shift = ensureShift(ym);
  shift.finalized = !shift.finalized;
  DB.save(db);
  renderDashboard();
  alert(shift.finalized ? `${ym} のシフトを確定しました。` : `${ym} のシフトの確定を解除しました。`);
});

function renderShortageBox(ym){
  const box = document.getElementById("shortageBox");
  const shift = ensureShift(ym);
  const dates = getMonthDates(ym);
  const lines = [];
  db.stores.forEach(store=>{
    dates.forEach(d=>{
      ["AM","PM"].forEach(sh=>{
        const need = sh==="AM"?store.amNeed:store.pmNeed;
        const cnt = shift.assignments.filter(a=>a.date===d.iso && a.storeId===store.id && a.shift===sh).length;
        if(cnt<need){
          lines.push(`${d.day}日(${WEEKDAYS[d.weekday]}) ${store.name} ${sh==="AM"?"午前":"午後"}：${cnt}/${need}名`);
        }
      });
    });
  });
  if(lines.length===0){
    box.className = "warning-box empty";
    box.innerHTML = "✔ 現在、人数不足の枠はありません。";
  }else{
    box.className = "warning-box";
    box.innerHTML = `<details><summary>⚠ 人数不足の枠：${lines.length}件（クリックで表示）</summary>
      <ul>${lines.map(l=>`<li>${escapeHtml(l)}</li>`).join("")}</ul></details>`;
  }
}

function renderStaffStats(ym){
  const tbl = document.getElementById("staffStatsTable");
  const shift = ensureShift(ym);
  const dates = getMonthDates(ym).map(d=>d.iso);

  let thead = `<thead><tr><th>スタッフ</th><th>勤務回数（コマ）</th><th>勤務日数</th><th>休み日数</th><th>最大連勤</th></tr></thead>`;
  let rows = db.staff.map(st=>{
    const myAssign = shift.assignments.filter(a=>a.staffId===st.id);
    const workDays = new Set(myAssign.map(a=>a.date));
    const offDays = dates.length - workDays.size;
    // 最大連勤計算
    let maxStreak=0, cur=0;
    dates.forEach(d=>{
      if(workDays.has(d)){ cur++; maxStreak=Math.max(maxStreak,cur); } else { cur=0; }
    });
    const flagStreak = maxStreak>=7;
    const flagOff = offDays<=2;
    return `<tr>
      <td>${escapeHtml(st.name)}</td>
      <td>${myAssign.length}</td>
      <td>${workDays.size}</td>
      <td class="${flagOff?'flag':''}">${offDays}${flagOff?' ⚠':''}</td>
      <td class="${flagStreak?'flag':''}">${maxStreak}${flagStreak?' ⚠':''}</td>
    </tr>`;
  }).join("");
  tbl.innerHTML = thead + `<tbody>${rows}</tbody>`;
}

/* =========================================================
   2. スタッフ管理
   ========================================================= */
function renderStaffTab(){
  fillStoreSelect(document.getElementById("staffBaseStore"));
  renderWeekdayChecks();
  renderStaffTable();
}

function renderWeekdayChecks(checked=[]){
  const wrap = document.getElementById("staffOffDays");
  wrap.innerHTML = WEEKDAYS.map((w,i)=>`
    <label><input type="checkbox" value="${i}" ${checked.includes(i)?"checked":""}> ${w}</label>
  `).join("");
}

function fillStoreSelect(sel){
  sel.innerHTML = db.stores.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
}

function renderStaffTable(){
  const tbl = document.getElementById("staffTable");
  let thead = `<thead><tr><th>氏名</th><th>資格</th><th>基本勤務店舗</th><th>基本休み</th><th>給与</th><th>メモ</th><th>操作</th></tr></thead>`;
  let rows = db.staff.map(st=>{
    const storeName = getStore(st.baseStore)?.name || "-";
    const offDays = st.baseOffDays.map(d=>WEEKDAYS[d]).join("・") || "なし";
    const wage = st.wage ? `${st.wage}円/${st.wageType==="hourly"?"時":"日"}` : "-";
    return `<tr>
      <td>${escapeHtml(st.name)}</td>
      <td>${escapeHtml(st.qualification||"-")}</td>
      <td>${escapeHtml(storeName)}</td>
      <td>${escapeHtml(offDays)}</td>
      <td>${wage}</td>
      <td>${escapeHtml(st.memo||"")}</td>
      <td class="row-actions">
        <button class="btn btn-xs btn-light" data-edit="${st.id}">編集</button>
        <button class="btn btn-xs btn-danger" data-del="${st.id}">削除</button>
      </td>
    </tr>`;
  }).join("");
  tbl.innerHTML = thead + `<tbody>${rows}</tbody>`;
}

document.getElementById("staffTable").addEventListener("click", (e)=>{
  const editId = e.target.closest("[data-edit]")?.dataset.edit;
  const delId = e.target.closest("[data-del]")?.dataset.del;
  if(editId){
    const st = getStaff(editId);
    document.getElementById("staffId").value = st.id;
    document.getElementById("staffName").value = st.name;
    document.getElementById("staffQualification").value = st.qualification||"";
    document.getElementById("staffBaseStore").value = st.baseStore;
    document.getElementById("staffHomeStore").value = st.homeStore||"";
    document.getElementById("staffWageType").value = st.wageType||"hourly";
    document.getElementById("staffWage").value = st.wage||0;
    document.getElementById("staffMemo").value = st.memo||"";
    renderWeekdayChecks(st.baseOffDays);
    window.scrollTo({top:0, behavior:"smooth"});
  }
  if(delId){
    if(!confirm("このスタッフを削除しますか？（パターン・申請も影響を受けます）")) return;
    db.staff = db.staff.filter(s=>s.id!==delId);
    delete db.patterns[delId];
    DB.save(db);
    renderStaffTable();
  }
});

document.getElementById("staffForm").addEventListener("submit", (e)=>{
  e.preventDefault();
  const id = document.getElementById("staffId").value;
  const offDays = Array.from(document.querySelectorAll("#staffOffDays input:checked")).map(c=>Number(c.value));
  const data = {
    name: document.getElementById("staffName").value.trim(),
    qualification: document.getElementById("staffQualification").value.trim(),
    baseStore: document.getElementById("staffBaseStore").value,
    homeStore: document.getElementById("staffHomeStore").value.trim(),
    wageType: document.getElementById("staffWageType").value,
    wage: Number(document.getElementById("staffWage").value)||0,
    baseOffDays: offDays,
    memo: document.getElementById("staffMemo").value.trim()
  };
  if(!data.name){ alert("氏名を入力してください。"); return; }
  if(id){
    Object.assign(getStaff(id), data);
  }else{
    const newId = uid("st");
    db.staff.push({id:newId, ...data});
    db.patterns[newId] = WEEKDAYS.map((_,wd)=> offDays.includes(wd) ? {am:null,pm:null} : {am:data.baseStore, pm:data.baseStore});
  }
  DB.save(db);
  document.getElementById("staffForm").reset();
  document.getElementById("staffId").value = "";
  renderWeekdayChecks();
  renderStaffTable();
});

document.getElementById("staffCancel").addEventListener("click", ()=>{
  document.getElementById("staffForm").reset();
  document.getElementById("staffId").value = "";
  renderWeekdayChecks();
});

/* =========================================================
   3. 店舗管理
   ========================================================= */
function renderStoresTab(){
  renderStoreTable();
}

function renderStoreTable(){
  const tbl = document.getElementById("storeTable");
  let thead = `<thead><tr><th>店舗名</th><th>午前必要人数</th><th>午後必要人数</th><th>メモ</th><th>操作</th></tr></thead>`;
  let rows = db.stores.map(s=>`
    <tr>
      <td>${escapeHtml(s.name)}</td>
      <td>${s.amNeed}</td>
      <td>${s.pmNeed}</td>
      <td>${escapeHtml(s.memo||"")}</td>
      <td class="row-actions">
        <button class="btn btn-xs btn-light" data-edit="${s.id}">編集</button>
        <button class="btn btn-xs btn-danger" data-del="${s.id}">削除</button>
      </td>
    </tr>`).join("");
  tbl.innerHTML = thead + `<tbody>${rows}</tbody>`;
}

document.getElementById("storeTable").addEventListener("click", (e)=>{
  const editId = e.target.closest("[data-edit]")?.dataset.edit;
  const delId = e.target.closest("[data-del]")?.dataset.del;
  if(editId){
    const s = getStore(editId);
    document.getElementById("storeId").value = s.id;
    document.getElementById("storeName").value = s.name;
    document.getElementById("storeAmNeed").value = s.amNeed;
    document.getElementById("storePmNeed").value = s.pmNeed;
    document.getElementById("storeMemo").value = s.memo||"";
    window.scrollTo({top:0, behavior:"smooth"});
  }
  if(delId){
    if(!confirm("この店舗を削除しますか？関連する勤務データには影響しません（参照のみ消えます）。")) return;
    db.stores = db.stores.filter(s=>s.id!==delId);
    DB.save(db);
    renderStoreTable();
  }
});

document.getElementById("storeForm").addEventListener("submit", (e)=>{
  e.preventDefault();
  const id = document.getElementById("storeId").value;
  const data = {
    name: document.getElementById("storeName").value.trim(),
    amNeed: Number(document.getElementById("storeAmNeed").value)||0,
    pmNeed: Number(document.getElementById("storePmNeed").value)||0,
    memo: document.getElementById("storeMemo").value.trim()
  };
  if(!data.name){ alert("店舗名を入力してください。"); return; }
  if(id){
    Object.assign(getStore(id), data);
  }else{
    db.stores.push({id:uid("s"), ...data});
  }
  DB.save(db);
  document.getElementById("storeForm").reset();
  document.getElementById("storeId").value = "";
  renderStoreTable();
});

document.getElementById("storeCancel").addEventListener("click", ()=>{
  document.getElementById("storeForm").reset();
  document.getElementById("storeId").value = "";
});

/* =========================================================
   4. 基本パターン管理
   ========================================================= */
function renderPatternTab(){
  const sel = document.getElementById("patternStaffSelect");
  sel.innerHTML = db.staff.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
  if(db.staff.length) renderPatternTable(sel.value);
}

document.getElementById("patternStaffSelect").addEventListener("change", (e)=>renderPatternTable(e.target.value));

function renderPatternTable(staffId){
  const tbl = document.getElementById("patternTable");
  if(!staffId){ tbl.innerHTML=""; return; }
  const pattern = db.patterns[staffId] || WEEKDAYS.map(()=>({am:null,pm:null}));
  const storeOptions = (selected)=> `<option value="">休み</option>` + db.stores.map(s=>
    `<option value="${s.id}" ${s.id===selected?"selected":""}>${escapeHtml(s.name)}</option>`).join("");

  let thead = `<thead><tr><th>曜日</th><th>午前</th><th>午後</th></tr></thead>`;
  let rows = WEEKDAYS.map((w,i)=>`
    <tr>
      <td>${w}</td>
      <td><select data-wd="${i}" data-part="am">${storeOptions(pattern[i].am)}</select></td>
      <td><select data-wd="${i}" data-part="pm">${storeOptions(pattern[i].pm)}</select></td>
    </tr>`).join("");
  tbl.innerHTML = thead + `<tbody>${rows}</tbody>`;
}

document.getElementById("btnSavePattern").addEventListener("click", ()=>{
  const staffId = document.getElementById("patternStaffSelect").value;
  if(!staffId) return;
  const rows = document.querySelectorAll("#patternTable tbody tr");
  const pattern = WEEKDAYS.map(()=>({am:null,pm:null}));
  rows.forEach(tr=>{
    const ams = tr.querySelector('select[data-part="am"]');
    const pms = tr.querySelector('select[data-part="pm"]');
    const wd = Number(ams.dataset.wd);
    pattern[wd] = {am: ams.value || null, pm: pms.value || null};
  });
  db.patterns[staffId] = pattern;
  DB.save(db);
  alert("基本パターンを保存しました。次回の月間シフト自動生成に反映されます。");
});

/* =========================================================
   5. 店舗別カレンダー
   ========================================================= */
function renderCalendarTab(){
  fillStoreSelect(document.getElementById("calStoreSelect"));
  document.getElementById("calMonth").value = shiftMonthInput.value || currentMonthStr();
  renderCalendar();
}
document.getElementById("calStoreSelect").addEventListener("change", renderCalendar);
document.getElementById("calMonth").addEventListener("change", renderCalendar);

function renderCalendar(){
  const grid = document.getElementById("calendarGrid");
  const storeId = document.getElementById("calStoreSelect").value;
  const ym = document.getElementById("calMonth").value;
  if(!storeId || !ym){ grid.innerHTML=""; return; }
  const shift = ensureShift(ym);
  const dates = getMonthDates(ym);

  let html = WEEKDAYS.map(w=>`<div class="cal-head">${w}</div>`).join("");
  const firstWd = dates[0].weekday;
  for(let i=0;i<firstWd;i++) html += `<div class="cal-cell blank"></div>`;

  dates.forEach(d=>{
    const am = shift.assignments.filter(a=>a.date===d.iso && a.storeId===storeId && a.shift==="AM").map(a=>getStaff(a.staffId)?.name||"?");
    const pm = shift.assignments.filter(a=>a.date===d.iso && a.storeId===storeId && a.shift==="PM").map(a=>getStaff(a.staffId)?.name||"?");
    const cls = d.weekday===0 ? "sun" : d.weekday===6 ? "sat" : "";
    html += `<div class="cal-cell ${cls}">
      <div class="cal-date">${d.day}</div>
      <div class="cal-shift-label">午前</div>
      <div class="cal-staff">${am.length?am.map(escapeHtml).join("、"):"-"}</div>
      <div class="cal-shift-label">午後</div>
      <div class="cal-staff">${pm.length?pm.map(escapeHtml).join("、"):"-"}</div>
    </div>`;
  });
  grid.innerHTML = html;
}

/* =========================================================
   6. 希望休申請一覧
   ========================================================= */
function renderRequestsTab(){
  fillStaffSelect(document.getElementById("reqStaff"));
  fillStoreSelect(document.getElementById("reqStore"));
  document.getElementById("reqTargetMonth").value = shiftMonthInput.value || currentMonthStr();
  renderRequestTable();
}

function fillStaffSelect(sel){
  sel.innerHTML = db.staff.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
}

document.getElementById("reqType").addEventListener("change", (e)=>{
  const isStoreNg = e.target.value === "店舗NG";
  document.getElementById("reqStoreLabel").hidden = !isStoreNg;
  document.getElementById("reqDateLabel").querySelector("input").required = !isStoreNg;
});

document.getElementById("requestForm").addEventListener("submit", (e)=>{
  e.preventDefault();
  const type = document.getElementById("reqType").value;
  const staffId = document.getElementById("reqStaff").value;
  const targetMonth = document.getElementById("reqTargetMonth").value;
  const date = document.getElementById("reqDate").value;
  const storeId = document.getElementById("reqStore").value;
  const memo = document.getElementById("reqMemo").value.trim();
  if(!staffId || !targetMonth){ alert("スタッフと対象月を指定してください。"); return; }
  if(type==="休み希望" && !date){ alert("休み希望の場合は日付を指定してください。"); return; }

  db.requests.push({
    id: uid("r"), staffId, type, targetMonth,
    date: date || null,
    storeId: type==="店舗NG" ? storeId : null,
    memo, status:"未確認"
  });
  DB.save(db);
  document.getElementById("requestForm").reset();
  document.getElementById("reqTargetMonth").value = shiftMonthInput.value || currentMonthStr();
  renderRequestTable();
});

function renderRequestTable(){
  const tbl = document.getElementById("requestTable");
  let thead = `<thead><tr><th>スタッフ</th><th>種別</th><th>対象月</th><th>日付/店舗</th><th>メモ</th><th>状態</th><th>操作</th></tr></thead>`;
  let rows = db.requests.slice().reverse().map(r=>{
    const st = getStaff(r.staffId);
    const target = r.type==="休み希望" ? (r.date||"-") : (getStore(r.storeId)?.name || "-") + (r.date?`（${r.date}のみ）`:"（当月全体）");
    return `<tr>
      <td>${st?escapeHtml(st.name):"（削除済み）"}</td>
      <td>${escapeHtml(r.type)}</td>
      <td>${r.targetMonth}</td>
      <td>${escapeHtml(target)}</td>
      <td>${escapeHtml(r.memo||"")}</td>
      <td><select class="status-select status-${r.status}" data-id="${r.id}">
        ${["未確認","確認済み","反映済み","却下"].map(s=>`<option value="${s}" ${s===r.status?"selected":""}>${s}</option>`).join("")}
      </select></td>
      <td><button class="btn btn-xs btn-danger" data-del="${r.id}">削除</button></td>
    </tr>`;
  }).join("");
  tbl.innerHTML = thead + `<tbody>${rows}</tbody>`;
}

document.getElementById("requestTable").addEventListener("click", (e)=>{
  const delId = e.target.closest("[data-del]")?.dataset.del;
  if(delId){
    if(!confirm("この申請を削除しますか？")) return;
    db.requests = db.requests.filter(r=>r.id!==delId);
    DB.save(db);
    renderRequestTable();
  }
});

document.getElementById("requestTable").addEventListener("change", (e)=>{
  const sel = e.target.closest(".status-select");
  if(!sel) return;
  const req = db.requests.find(r=>r.id===sel.dataset.id);
  const newStatus = sel.value;
  if(newStatus==="反映済み"){
    const ok = applyRequestToShift(req);
    if(!ok){ sel.value = req.status; return; }
  }
  req.status = newStatus;
  DB.save(db);
  renderRequestTable();
});

function applyRequestToShift(req){
  const shift = db.shifts[req.targetMonth];
  if(!shift){
    alert("対象月の仮シフトがまだ生成されていません。先に「代表者管理」で自動生成してください。");
    return false;
  }
  if(req.type==="休み希望"){
    shift.assignments = shift.assignments.filter(a=>!(a.staffId===req.staffId && a.date===req.date));
  }else if(req.type==="店舗NG"){
    shift.assignments = shift.assignments.filter(a=>{
      if(a.staffId!==req.staffId || a.storeId!==req.storeId) return true;
      if(req.date) return a.date!==req.date;
      return false; // 日付指定なし＝当月全体から除外
    });
  }
  DB.save(db);
  return true;
}

/* ---------- 共通：HTMLエスケープ ---------- */
function escapeHtml(str){
  return String(str ?? "").replace(/[&<>"']/g, c=>({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
  }[c]));
}

/* ---------- 初期表示 ---------- */
renderDashboard();
