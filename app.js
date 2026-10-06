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

if(!isConfigured) $("#setupWarning").hidden = false;

const mb = n => (n / 1024 / 1024).toFixed(1);

function fileOk(file, maxMb, type){
  if(!file) return `${type} 파일을 선택하세요.`;
  if(file.size > maxMb * 1024 * 1024) return `${type} 파일이 너무 큽니다. ${maxMb}MB 이하로 준비해 주세요.`;
  return "";
}

function cleanStudentId(v){
  return String(v ?? "").trim().replace(/\s+/g, "").replace(/[^0-9A-Za-z가-힣_-]/g, "");
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
function setProgress(p, label=""){
  const value = Math.max(0, Math.min(100, p));
  $("#bar").style.width = `${value}%`;
  const progressText = $("#progressText");
  const progressPercent = $("#progressPercent");
  if(progressText){
    progressText.textContent = label ? `AR 제작 중 · ${label}` : "AR 제작 중";
  }
  if(progressPercent){
    progressPercent.textContent = `${Math.round(value)}%`;
  }
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

async function ensureMindARCompiler(){
  const findCompiler = () =>
    window.MINDAR?.IMAGE?.Compiler ||
    window.MINDAR?.Compiler ||
    null;

  let CompilerClass = findCompiler();
  if(CompilerClass) return CompilerClass;

  // MindAR 1.1.4 classic build exposes the compiler directly in the browser.
  await new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-artlive-mindar-classic]');
    if(existing){
      if(findCompiler()) { resolve(); return; }
      existing.addEventListener("load", resolve, {once:true});
      existing.addEventListener("error", reject, {once:true});
      return;
    }

    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/gh/hiukim/mind-ar-js@1.1.4/dist/mindar-image.prod.js";
    script.async = true;
    script.dataset.artliveMindarClassic = "1";
    script.onload = resolve;
    script.onerror = () => reject(new Error("AR 분석 라이브러리를 불러오지 못했습니다."));
    document.head.appendChild(script);
  });

  // Give the classic bundle a moment to expose its global.
  await new Promise(resolve => setTimeout(resolve, 50));

  CompilerClass = findCompiler();
  if(!CompilerClass){
    throw new Error("AR 분석 기능을 시작하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.");
  }
  return CompilerClass;
}
async function compileMindFromImage(file){
  const CompilerClass = await ensureMindARCompiler();

  const {img, url} = await loadImage(file);
  try{
    const compiler = new CompilerClass();
    await compiler.compileImageTargets([img], (progress) => {
      const numericProgress = Number(progress) || 0;
      const mapped = 10 + (numericProgress / 100) * 25;
      setProgress(mapped, "AR 인식 분석 중");
      setStatus(`작품 이미지에서 AR 인식정보를 자동 생성하고 있습니다… ${Math.round(numericProgress)}%`);
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
    $("#"+id+"Meta").textContent=f ? `${f.name} · ${mb(f.size)}MB` : "";
  });
});

$("#createForm").addEventListener("submit", async (e)=>{
  e.preventDefault();

  if(!isConfigured){
    setStatus("Supabase 설정을 확인해 주세요.", "error");
    return;
  }

  const schoolCode = sanitize($("#schoolCode").value).toUpperCase();
  const studentId = cleanStudentId($("#studentId").value);
  const imageFile = $("#imageFile").files?.[0];
  const videoFile = $("#videoFile").files?.[0];

  const errors = [
    !studentId ? "학번을 입력하세요." : "",
    studentId.length > 20 ? "학번은 20자 이하로 입력하세요." : "",
    fileOk(imageFile, MAX_IMAGE_MB, "작품 이미지"),
    fileOk(videoFile, VIDEO_LIMIT_MB, "영상")
  ].filter(Boolean);

  if(errors.length){
    setStatus(errors[0], "error");
    return;
  }

  $("#submitBtn").classList.remove("done");
  $("#submitBtn").disabled = true;
  $("#submitBtn").textContent = "AR 제작 중…";
  $("#submitBtn").classList.add("working");
  $("#result").hidden = true;
  setProgress(3, "준비 중");
  setStatus("AR로 만들기를 준비하고 있습니다…");

  try{
    const school = await validateSchool(schoolCode);
    if(!school) throw new Error("학교 설정을 확인할 수 없습니다.");

    const {width,height} = await getImageSize(imageFile);

    setProgress(8, "이미지 분석 준비");
    setStatus("작품 이미지에서 AR 인식정보를 자동 생성합니다. 잠시 기다려 주세요…");
    const mindBlob = await compileMindFromImage(imageFile);

    const projectId = crypto.randomUUID();
    const base = `${schoolCode}/${studentId}/${projectId}`;
    const imageExt = (imageFile.name.split(".").pop() || "jpg").toLowerCase();
    const videoExt = (videoFile.name.split(".").pop() || "mp4").toLowerCase();

    setStatus("작품 이미지를 업로드하고 있습니다…");
    setProgress(40, "이미지 업로드 중");
    let r = await supabase.storage.from("ar-assets").upload(`${base}/target.${imageExt}`, imageFile, {
      cacheControl:"3600", upsert:false, contentType:imageFile.type || "image/jpeg"
    });
    if(r.error) throw r.error;

    setStatus(`영상을 업로드하고 있습니다… (${mb(videoFile.size)}MB)`);
    setProgress(55, "영상 업로드 중");
    r = await supabase.storage.from("ar-assets").upload(`${base}/video.${videoExt}`, videoFile, {
      cacheControl:"3600", upsert:false, contentType:videoFile.type || "video/mp4"
    });
    if(r.error) throw r.error;

    setStatus("AR 인식정보를 저장하고 있습니다…");
    setProgress(80, "AR 인식정보 저장 중");
    r = await supabase.storage.from("ar-assets").upload(`${base}/targets.mind`, mindBlob, {
      cacheControl:"3600", upsert:false, contentType:"application/octet-stream"
    });
    if(r.error) throw r.error;

    const imageUrl = supabase.storage.from("ar-assets").getPublicUrl(`${base}/target.${imageExt}`).data.publicUrl;
    const videoUrl = supabase.storage.from("ar-assets").getPublicUrl(`${base}/video.${videoExt}`).data.publicUrl;
    const mindUrl = supabase.storage.from("ar-assets").getPublicUrl(`${base}/targets.mind`).data.publicUrl;

    setStatus("작품 정보를 저장하고 있습니다…");
    setProgress(92, "작품 정보 저장 중");

    const {error:insertError} = await supabase.from("projects").insert({
      id: projectId,
      school_code: schoolCode,
      student_id: studentId,
      title: `${studentId} AR 작품`,
      image_url: imageUrl,
      video_url: videoUrl,
      mind_url: mindUrl,
      image_width: width,
      image_height: height,
      grade: 1,
      class_no: 1,
      student_no: 1
    });
    if(insertError) throw insertError;

    setProgress(100, "완료");
    $("#submitBtn").textContent = "AR 제작 완료";
    $("#submitBtn").classList.remove("working");
    $("#submitBtn").classList.add("done");
    const viewUrl = new URL("ar.html", location.href);
    viewUrl.searchParams.set("id", projectId);
    $("#resultLink").href = viewUrl.href;
    $("#resultLink").textContent = "내 AR 작품 열기";
    $("#resultId").textContent = `${school.name} · 학번 ${studentId}`;
    $("#result").hidden = false;
    setStatus("완료되었습니다. 아래 ‘내 AR 작품 열기’를 눌러 확인하세요.", "ok");
  }catch(err){
    console.error(err);
    let msg = err?.message || "저장 중 오류가 발생했습니다.";
    if(/maximum|too large|payload|entity too large|file size/i.test(msg)){
      msg += " 영상 파일 크기 또는 Supabase Storage 제한을 확인해 주세요.";
    }
    setStatus(msg, "error");
    setProgress(0, "오류");
  }finally{
    $("#submitBtn").disabled = false;
    if(!$("#submitBtn").classList.contains("done")){
      $("#submitBtn").textContent = "AR로 만들기";
      $("#submitBtn").classList.remove("working");
    }
  }
});

$("#findForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const msg=$("#findStatus");

  if(!isConfigured){
    msg.textContent="Supabase 설정을 확인해 주세요.";
    msg.className="notice error";
    msg.hidden=false;
    return;
  }

  const schoolCode=sanitize($("#findSchoolCode").value).toUpperCase();
  const studentId=cleanStudentId($("#findStudentId").value);

  if(!studentId){
    msg.textContent="학번을 입력하세요.";
    msg.className="notice error";
    msg.hidden=false;
    return;
  }

  msg.textContent="작품을 찾고 있습니다…";
  msg.className="notice";
  msg.hidden=false;

  try{
    const {data,error}=await supabase.from("projects")
      .select("id,student_id,created_at")
      .eq("school_code",schoolCode)
      .eq("student_id",studentId)
      .order("created_at",{ascending:false})
      .limit(1)
      .maybeSingle();

    if(error) throw error;
    if(!data) throw new Error("해당 학번으로 만든 작품이 없습니다.");

    const url=new URL("ar.html",location.href);
    url.searchParams.set("id",data.id);
    location.href=url.href;
  }catch(err){
    msg.textContent=err?.message || "작품을 찾지 못했습니다.";
    msg.className="notice error";
  }
});
