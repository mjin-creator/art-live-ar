import { supabase, isConfigured } from "./supabase-client.js";
import { MAX_IMAGE_MB } from "./config.js";

const VIDEO_LIMIT_MB = 45;
const $ = (s) => document.querySelector(s);
const tabs = document.querySelectorAll(".tab");
const panels = document.querySelectorAll(".panel");

function showPanel(name){
  tabs.forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  panels.forEach(p => p.hidden = p.id !== `panel-${name}`);
}
tabs.forEach(b => b.addEventListener("click", () => showPanel(b.dataset.tab)));

const setupWarning = $("#setupWarning");
if(!isConfigured) setupWarning.hidden = false;

const mb = n => (n / 1024 / 1024).toFixed(1);

function fileOk(file, maxMb, type){
  if(!file) return `${type} 파일을 선택하세요.`;
  if(file.size > maxMb * 1024 * 1024) return `${type} 파일이 너무 큽니다. ${maxMb}MB 이하로 준비해 주세요.`;
  return "";
}
function sanitize(v){
  return String(v ?? "").trim().replace(/[^\p{L}\p{N}_-]/gu, "");
}
function setStatus(msg, type=""){
  const el = $("#status");
  el.textContent = msg;
  el.className = `notice ${type}`.trim();
  el.hidden = false;
}
function setProgress(p){
  $("#bar").style.width = `${Math.max(0, Math.min(100,p))}%`;
}

async function loadImage(file){
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({img, url});
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("작품 이미지를 읽을 수 없습니다."));
    };
    img.src = url;
  });
}

async function getImageSize(file){
  const {img, url} = await loadImage(file);
  const size = {width: img.naturalWidth, height: img.naturalHeight};
  URL.revokeObjectURL(url);
  return size;
}

async function compileMindFromImage(file){
  if(!window.MINDAR?.IMAGE?.Compiler){
    throw new Error("AR 자동 분석 모듈을 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 새로고침해 주세요.");
  }

  const {img, url} = await loadImage(file);
  try{
    const compiler = new window.MINDAR.IMAGE.Compiler();
    await compiler.compileImageTargets([img], (progress) => {
      const mapped = 10 + (Number(progress) / 100) * 25;
      setProgress(mapped);
      setStatus(`작품을 AR용으로 자동 분석하고 있습니다… ${Math.round(progress)}%`);
    });
    const exportedBuffer = await compiler.exportData();
    return new Blob([exportedBuffer], {type:"application/octet-stream"});
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function validateSchool(code){
  const { data, error } = await supabase.from("schools")
    .select("code,name,is_active")
    .eq("code", code)
    .eq("is_active", true)
    .maybeSingle();
  if(error) throw error;
  return data;
}

["imageFile","videoFile"].forEach(id=>{
  $("#" + id).addEventListener("change", e=>{
    const f=e.target.files?.[0];
    const meta=$("#"+id+"Meta");
    meta.textContent=f ? `${f.name} · ${mb(f.size)}MB` : "";
  });
});

$("#createForm").addEventListener("submit", async (e)=>{
  e.preventDefault();

  if(!isConfigured){
    setStatus("먼저 config.js에 Supabase URL과 publishable key를 넣어 주세요.", "error");
    return;
  }

  const schoolCode = sanitize($("#schoolCode").value).toUpperCase();
  const grade = Number($("#grade").value);
  const classNo = Number($("#classNo").value);
  const studentNo = Number($("#studentNo").value);
  const title = $("#title").value.trim().slice(0,80);
  const imageFile = $("#imageFile").files?.[0];
  const videoFile = $("#videoFile").files?.[0];

  const errors = [
    !schoolCode ? "학교 설정 오류가 있습니다." : "",
    !(grade>=1 && grade<=6) ? "학년을 확인하세요." : "",
    !(classNo>=1 && classNo<=30) ? "반을 확인하세요." : "",
    !(studentNo>=1 && studentNo<=60) ? "번호를 확인하세요." : "",
    fileOk(imageFile, MAX_IMAGE_MB, "작품 이미지"),
    fileOk(videoFile, VIDEO_LIMIT_MB, "영상")
  ].filter(Boolean);

  if(errors.length){
    setStatus(errors[0], "error");
    return;
  }

  $("#submitBtn").disabled = true;
  $("#result").hidden = true;
  setProgress(3);
  setStatus("AR 작품 만들기를 준비하고 있습니다…");

  try{
    const school = await validateSchool(schoolCode);
    if(!school) throw new Error("학교 설정을 확인할 수 없습니다.");

    const {width,height} = await getImageSize(imageFile);

    setProgress(8);
    setStatus("작품 이미지에서 AR 인식정보를 자동 생성합니다. 잠시 기다려 주세요…");
    const mindBlob = await compileMindFromImage(imageFile);

    const projectId = crypto.randomUUID();
    const studentKey = `${grade}-${classNo}-${String(studentNo).padStart(2,"0")}`;
    const base = `${schoolCode}/${studentKey}/${projectId}`;
    const imageExt = (imageFile.name.split(".").pop() || "jpg").toLowerCase();
    const videoExt = (videoFile.name.split(".").pop() || "mp4").toLowerCase();

    setStatus("작품 이미지를 업로드하고 있습니다…");
    setProgress(40);
    let r = await supabase.storage.from("ar-assets").upload(`${base}/target.${imageExt}`, imageFile, {
      cacheControl:"3600",
      upsert:false,
      contentType:imageFile.type || "image/jpeg"
    });
    if(r.error) throw r.error;

    setStatus(`영상을 업로드하고 있습니다… (${mb(videoFile.size)}MB)`);
    setProgress(55);
    r = await supabase.storage.from("ar-assets").upload(`${base}/video.${videoExt}`, videoFile, {
      cacheControl:"3600",
      upsert:false,
      contentType:videoFile.type || "video/mp4"
    });
    if(r.error) throw r.error;

    setStatus("AR 인식정보를 저장하고 있습니다…");
    setProgress(80);
    r = await supabase.storage.from("ar-assets").upload(`${base}/targets.mind`, mindBlob, {
      cacheControl:"3600",
      upsert:false,
      contentType:"application/octet-stream"
    });
    if(r.error) throw r.error;

    const imageUrl = supabase.storage.from("ar-assets").getPublicUrl(`${base}/target.${imageExt}`).data.publicUrl;
    const videoUrl = supabase.storage.from("ar-assets").getPublicUrl(`${base}/video.${videoExt}`).data.publicUrl;
    const mindUrl = supabase.storage.from("ar-assets").getPublicUrl(`${base}/targets.mind`).data.publicUrl;

    setStatus("작품 정보를 저장하고 있습니다…");
    setProgress(92);

    const {error:insertError} = await supabase.from("projects").insert({
      id: projectId,
      school_code: schoolCode,
      grade,
      class_no: classNo,
      student_no: studentNo,
      title: title || `${studentKey} AR 작품`,
      image_url: imageUrl,
      video_url: videoUrl,
      mind_url: mindUrl,
      image_width: width,
      image_height: height
    });
    if(insertError) throw insertError;

    setProgress(100);
    const viewUrl = new URL("ar.html", location.href);
    viewUrl.searchParams.set("id", projectId);
    $("#resultLink").href = viewUrl.href;
    $("#resultLink").textContent = "내 AR 작품 열기";
    $("#resultId").textContent = `${school.name} · ${grade}학년 ${classNo}반 ${studentNo}번`;
    $("#result").hidden = false;
    setStatus("완료되었습니다. 아래 ‘내 AR 작품 열기’를 눌러 확인하세요.", "ok");
  }catch(err){
    console.error(err);
    let msg = err?.message || "저장 중 오류가 발생했습니다.";
    if(/maximum|too large|payload|entity too large|file size/i.test(msg)){
      msg += " 영상 파일 크기 또는 Supabase Storage 제한을 확인해 주세요.";
    }
    setStatus(msg, "error");
    setProgress(0);
  }finally{
    $("#submitBtn").disabled = false;
  }
});

$("#findForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const msg=$("#findStatus");

  if(!isConfigured){
    msg.textContent="먼저 config.js에 Supabase 설정을 넣어 주세요.";
    msg.className="notice error";
    msg.hidden=false;
    return;
  }

  const schoolCode=sanitize($("#findSchoolCode").value).toUpperCase();
  const grade=Number($("#findGrade").value);
  const classNo=Number($("#findClassNo").value);
  const studentNo=Number($("#findStudentNo").value);

  msg.textContent="작품을 찾고 있습니다…";
  msg.className="notice";
  msg.hidden=false;

  try{
    const {data,error}=await supabase.from("projects")
      .select("id,title,created_at")
      .eq("school_code",schoolCode)
      .eq("grade",grade)
      .eq("class_no",classNo)
      .eq("student_no",studentNo)
      .order("created_at",{ascending:false})
      .limit(1)
      .maybeSingle();

    if(error) throw error;
    if(!data) throw new Error("해당 번호로 등록된 작품이 없습니다.");

    const url=new URL("ar.html",location.href);
    url.searchParams.set("id",data.id);
    location.href=url.href;
  }catch(err){
    msg.textContent=err?.message || "작품을 찾지 못했습니다.";
    msg.className="notice error";
  }
});
