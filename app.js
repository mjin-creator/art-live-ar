import { supabase, isConfigured } from "./supabase-client.js";
import { MINDAR_COMPILER_URL, MAX_IMAGE_MB, MAX_VIDEO_MB, MAX_MIND_MB } from "./config.js";

const $ = (s) => document.querySelector(s);
const tabs = document.querySelectorAll(".tab");
const panels = document.querySelectorAll(".panel");

function showPanel(name){
  tabs.forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  panels.forEach(p => p.hidden = p.id !== `panel-${name}`);
}
tabs.forEach(b => b.addEventListener("click", () => showPanel(b.dataset.tab)));

$("#compilerLink").href = MINDAR_COMPILER_URL;

const setupWarning = $("#setupWarning");
if(!isConfigured){
  setupWarning.hidden = false;
}

const mb = n => (n / 1024 / 1024).toFixed(1);

function fileOk(file, maxMb, type){
  if(!file) return `${type} 파일을 선택하세요.`;
  if(file.size > maxMb * 1024 * 1024) return `${type} 파일이 너무 큽니다. ${maxMb}MB 이하로 줄여 주세요.`;
  return "";
}
function sanitize(v){ return String(v ?? "").trim().replace(/[^\p{L}\p{N}_-]/gu, ""); }

async function getImageSize(file){
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve({width: img.naturalWidth, height: img.naturalHeight}); URL.revokeObjectURL(url); };
    img.onerror = () => { reject(new Error("이미지를 읽을 수 없습니다.")); URL.revokeObjectURL(url); };
    img.src = url;
  });
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

function setStatus(msg, type=""){
  const el = $("#status");
  el.textContent = msg;
  el.className = `notice ${type}`.trim();
  el.hidden = false;
}
function setProgress(p){
  $("#bar").style.width = `${Math.max(0, Math.min(100,p))}%`;
}

["imageFile","videoFile","mindFile"].forEach(id=>{
  $( "#" + id).addEventListener("change", e=>{
    const f=e.target.files?.[0];
    const meta=$("#"+id+"Meta");
    meta.textContent=f ? `${f.name} · ${mb(f.size)}MB` : "";
  });
});

$("#createForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  if(!isConfigured){
    setStatus("먼저 config.js에 Supabase URL과 anon key를 넣어 주세요.", "error");
    return;
  }

  const schoolCode = sanitize($("#schoolCode").value).toUpperCase();
  const grade = Number($("#grade").value);
  const classNo = Number($("#classNo").value);
  const studentNo = Number($("#studentNo").value);
  const title = $("#title").value.trim().slice(0,80);
  const imageFile = $("#imageFile").files?.[0];
  const videoFile = $("#videoFile").files?.[0];
  const mindFile = $("#mindFile").files?.[0];

  const errors = [
    !schoolCode ? "학교코드를 입력하세요." : "",
    !(grade>=1 && grade<=6) ? "학년을 확인하세요." : "",
    !(classNo>=1 && classNo<=30) ? "반을 확인하세요." : "",
    !(studentNo>=1 && studentNo<=60) ? "번호를 확인하세요." : "",
    fileOk(imageFile, MAX_IMAGE_MB, "작품 이미지"),
    fileOk(videoFile, MAX_VIDEO_MB, "영상"),
    fileOk(mindFile, MAX_MIND_MB, "targets.mind")
  ].filter(Boolean);
  if(mindFile && !mindFile.name.toLowerCase().endsWith(".mind")) errors.push("인식파일은 .mind 파일이어야 합니다.");
  if(errors.length){ setStatus(errors[0], "error"); return; }

  $("#submitBtn").disabled = true;
  setProgress(5);
  setStatus("학교코드를 확인하고 있습니다…");

  try{
    const school = await validateSchool(schoolCode);
    if(!school) throw new Error("등록되지 않았거나 비활성화된 학교코드입니다.");

    const {width,height} = await getImageSize(imageFile);
    const projectId = crypto.randomUUID();
    const studentKey = `${grade}-${classNo}-${String(studentNo).padStart(2,"0")}`;
    const base = `${schoolCode}/${studentKey}/${projectId}`;

    const imageExt = (imageFile.name.split(".").pop() || "jpg").toLowerCase();
    const videoExt = (videoFile.name.split(".").pop() || "mp4").toLowerCase();

    setStatus("작품 이미지를 업로드하고 있습니다…"); setProgress(20);
    let r = await supabase.storage.from("ar-assets").upload(`${base}/target.${imageExt}`, imageFile, {
      cacheControl:"3600", upsert:false, contentType:imageFile.type || "image/jpeg"
    });
    if(r.error) throw r.error;

    setStatus("영상을 업로드하고 있습니다…"); setProgress(45);
    r = await supabase.storage.from("ar-assets").upload(`${base}/video.${videoExt}`, videoFile, {
      cacheControl:"3600", upsert:false, contentType:videoFile.type || "video/mp4"
    });
    if(r.error) throw r.error;

    setStatus("AR 인식파일을 업로드하고 있습니다…"); setProgress(65);
    r = await supabase.storage.from("ar-assets").upload(`${base}/targets.mind`, mindFile, {
      cacheControl:"3600", upsert:false, contentType:"application/octet-stream"
    });
    if(r.error) throw r.error;

    const imageUrl = supabase.storage.from("ar-assets").getPublicUrl(`${base}/target.${imageExt}`).data.publicUrl;
    const videoUrl = supabase.storage.from("ar-assets").getPublicUrl(`${base}/video.${videoExt}`).data.publicUrl;
    const mindUrl = supabase.storage.from("ar-assets").getPublicUrl(`${base}/targets.mind`).data.publicUrl;

    setStatus("작품 정보를 저장하고 있습니다…"); setProgress(85);
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
    setStatus("완료되었습니다. 아래 ‘내 AR 작품 열기’를 눌러 테스트하세요.", "ok");
  }catch(err){
    console.error(err);
    setStatus(err?.message || "저장 중 오류가 발생했습니다.", "error");
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
    msg.className="notice error"; msg.hidden=false; return;
  }
  const schoolCode=sanitize($("#findSchoolCode").value).toUpperCase();
  const grade=Number($("#findGrade").value);
  const classNo=Number($("#findClassNo").value);
  const studentNo=Number($("#findStudentNo").value);

  msg.textContent="작품을 찾고 있습니다…"; msg.className="notice"; msg.hidden=false;
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
