/* ======================================================================
   BASE DE DATOS (localStorage). Todo lo que crean/editan Admisiones,
   Director de Escuela y Coordinador queda guardado aquí, y el módulo
   de Estudiantes lee siempre estos mismos datos, así que los cambios
   se ven apenas el estudiante entra o recarga su panel.
   ====================================================================== */

/* ----------------------------------------------------------------------
   CONEXIÓN SUPABASE — MÓDULO 1: USUARIOS (cuentas_admin, docentes, estudiantes)

   Estrategia de migración progresiva: Supabase pasa a ser la fuente de
   verdad para estas 3 tablas, pero el resto del código (70+ lugares) sigue
   leyendo/escribiendo de forma SÍNCRONA las claves uan_cuentas_admin,
   uan_docentes, uan_estudiantes en localStorage, sin que haya que tocarlo.

   Cómo funciona:
   1) Al cargar la página, sincronizarUsuariosDesdeSupabase() descarga las
      3 tablas y sobreescribe esas 3 claves de localStorage.
   2) Cada vez que se llama saveCuentasAdmin/saveDocentes/saveEstudiantes
      (igual que siempre), además de guardar en localStorage se empuja el
      estado completo a Supabase en segundo plano, para que quede disponible
      desde cualquier otro navegador/dispositivo.

   Los demás módulos (pensum, grupos, notas, evaluaciones, etc.) siguen
   100% en localStorage por ahora; se migran uno a uno más adelante.
   ---------------------------------------------------------------------- */
const SUPABASE_URL = "https://ecziuxtlinyqpeybknhe.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVjeml1eHRsaW55cXBleWJrbmhlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY1NjExNjEsImV4cCI6MjEwMjEzNzE2MX0.jnluqe35tp29q72i0uTnbZ6guhmDYM1pnwgua_ulfZQ";
const supabaseClient = (typeof window !== "undefined" && window.supabase)
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

/* Bandera que indica si ya se terminó de sincronizar con Supabase por lo
   menos una vez. mostrarLogin() la usa para avisar si el usuario intenta
   entrar mientras todavía está cargando (debería tardar menos de 1 segundo). */
let datosListos = false;

async function sincronizarUsuariosDesdeSupabase(){
  if(!supabaseClient){
    console.warn("Supabase no está disponible (¿no cargó el script del CDN?). Se sigue usando solo localStorage.");
    return;
  }
  try{
    const [rCuentas, rDocentes, rEstudiantes] = await Promise.all([
      supabaseClient.from("cuentas_admin").select("usuario,password,rol,programa"),
      supabaseClient.from("docentes").select("id,programa,usuario,data"),
      supabaseClient.from("estudiantes").select("codigo,data")
    ]);
    if(rCuentas.error) console.error("Error leyendo cuentas_admin de Supabase:", rCuentas.error);
    if(rDocentes.error) console.error("Error leyendo docentes de Supabase:", rDocentes.error);
    if(rEstudiantes.error) console.error("Error leyendo estudiantes de Supabase:", rEstudiantes.error);

    if(!rCuentas.error && rCuentas.data){
      localStorage.setItem("uan_cuentas_admin", JSON.stringify(rCuentas.data));
    }
    if(!rDocentes.error && rDocentes.data){
      const docentesObj = {};
      rDocentes.data.forEach(row=>{
        if(!docentesObj[row.programa]) docentesObj[row.programa]=[];
        docentesObj[row.programa].push({...row.data, id:row.id, usuario:row.usuario});
      });
      localStorage.setItem("uan_docentes", JSON.stringify(docentesObj));
    }
    if(!rEstudiantes.error && rEstudiantes.data){
      const estudiantesObj = {};
      rEstudiantes.data.forEach(row=>{
        estudiantesObj[row.codigo] = {...row.data, codigo:row.codigo};
      });
      localStorage.setItem("uan_estudiantes", JSON.stringify(estudiantesObj));
    }
  }catch(err){
    console.error("No se pudo conectar con Supabase, se sigue usando la copia local guardada en este navegador:", err);
  }
}

/* Empujan el estado COMPLETO de cada tabla a Supabase (borran todo lo que
   había y vuelven a insertar). Al tamaño de estas 3 tablas (decenas o
   cientos de filas típicamente) esto es rápido y evita tener que calcular
   diffs cada vez que se crea/edita una cuenta. Se disparan "en segundo
   plano" (sin await) desde save*, así ningún llamador actual del código
   tiene que volverse async. */
async function empujarCuentasAdminASupabase(arr){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("cuentas_admin").delete().gte("id", 0);
    if(arr.length){
      const { error } = await supabaseClient.from("cuentas_admin").insert(
        arr.map(c=>({usuario:c.usuario, password:c.password, rol:c.rol, programa:c.programa||null}))
      );
      if(error) console.error("No se pudo guardar cuentas_admin en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar cuentas_admin en Supabase:", err); }
}
async function empujarDocentesASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("docentes").delete().neq("id", "___ninguno___");
    const filas = [];
    Object.keys(obj).forEach(programa=>{
      (obj[programa]||[]).forEach(d=>{
        const {id, usuario, ...resto} = d;
        filas.push({id, programa, usuario, data:resto});
      });
    });
    if(filas.length){
      const { error } = await supabaseClient.from("docentes").insert(filas);
      if(error) console.error("No se pudo guardar docentes en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar docentes en Supabase:", err); }
}
async function empujarEstudiantesASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("estudiantes").delete().neq("codigo", "___ninguno___");
    const filas = Object.keys(obj).map(codigo=>{
      const {codigo:_c, ...resto} = obj[codigo];
      return {codigo, data:resto};
    });
    if(filas.length){
      const { error } = await supabaseClient.from("estudiantes").insert(filas);
      if(error) console.error("No se pudo guardar estudiantes en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar estudiantes en Supabase:", err); }
}

const CUENTAS_ADMIN_SEED = [
  {usuario:"admin",    password:"1", rol:"admisiones"},
  {usuario:"sistemas", password:"1", rol:"director",     programa:"Sistemas"},
  {usuario:"sistemas", password:"2", rol:"coordinador",  programa:"Sistemas"}
];
function getCuentasAdmin(){
  const stored = localStorage.getItem("uan_cuentas_admin");
  if(stored) return JSON.parse(stored);
  localStorage.setItem("uan_cuentas_admin", JSON.stringify(CUENTAS_ADMIN_SEED));
  return CUENTAS_ADMIN_SEED.slice();
}
function saveCuentasAdmin(arr){
  localStorage.setItem("uan_cuentas_admin", JSON.stringify(arr));
  empujarCuentasAdminASupabase(arr);
}

/* Todos los nombres de programas/carreras que existen en el sistema hasta ahora
   (tengan o no pensum todavía), para ofrecerlos como sugerencia al crear cuentas. */
function listaProgramasConocidos(){
  const deCuentas = getCuentasAdmin().map(c=>c.programa).filter(Boolean);
  const dePensums = Object.keys(getProgramas());
  return [...new Set([...deCuentas, ...dePensums])].sort();
}

function getEstudiantes(){ return JSON.parse(localStorage.getItem("uan_estudiantes") || "{}"); }
function saveEstudiantes(obj){
  localStorage.setItem("uan_estudiantes", JSON.stringify(obj));
  empujarEstudiantesASupabase(obj);
}

/* ----------------------------------------------------------------------
   MÓDULO 2: PROGRAMAS Y PENSUM — mismo patrón que usuarios: Supabase
   descarga y sobreescribe uan_programas en localStorage al cargar, y
   savePrograms empuja el objeto completo a Supabase en segundo plano.
   ---------------------------------------------------------------------- */
async function sincronizarProgramasDesdeSupabase(){
  if(!supabaseClient) return;
  try{
    const { data, error } = await supabaseClient.from("programas").select("nombre,data");
    if(error){ console.error("Error leyendo programas de Supabase:", error); return; }
    const programasObj = {};
    (data||[]).forEach(row=>{ programasObj[row.nombre] = row.data; });
    localStorage.setItem("uan_programas", JSON.stringify(programasObj));
  }catch(err){
    console.error("No se pudo conectar con Supabase (programas), se sigue usando la copia local:", err);
  }
}
async function empujarProgramasASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("programas").delete().neq("nombre", "___ninguno___");
    const filas = Object.keys(obj).map(nombre=>({nombre, data:obj[nombre]}));
    if(filas.length){
      const { error } = await supabaseClient.from("programas").insert(filas);
      if(error) console.error("No se pudo guardar programas en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar programas en Supabase:", err); }
}

function getProgramas(){ return JSON.parse(localStorage.getItem("uan_programas") || "{}"); }
function savePrograms(obj){
  localStorage.setItem("uan_programas", JSON.stringify(obj));
  empujarProgramasASupabase(obj);
}

function getHorarios(){ return JSON.parse(localStorage.getItem("uan_horarios") || "{}"); }
function saveHorarios(obj){ localStorage.setItem("uan_horarios", JSON.stringify(obj)); }

function getDocentes(){ return JSON.parse(localStorage.getItem("uan_docentes") || "{}"); }
function saveDocentes(obj){
  localStorage.setItem("uan_docentes", JSON.stringify(obj));
  empujarDocentesASupabase(obj);
}

function siguienteIdDocente(){
  let n = parseInt(localStorage.getItem("uan_next_docente_id") || "1", 10);
  localStorage.setItem("uan_next_docente_id", String(n+1));
  return n; // número, usado también para generar el usuario
}

/* ----------------------------------------------------------------------
   MÓDULO 3: GRUPOS (con horarios embebidos en "bloques" dentro de cada
   grupo) — mismo patrón que usuarios y programas.
   ---------------------------------------------------------------------- */
async function sincronizarGruposDesdeSupabase(){
  if(!supabaseClient) return;
  try{
    const { data, error } = await supabaseClient.from("grupos").select("id,programa,materia,data");
    if(error){ console.error("Error leyendo grupos de Supabase:", error); return; }
    const gruposObj = {};
    (data||[]).forEach(row=>{
      if(!gruposObj[row.programa]) gruposObj[row.programa] = {};
      if(!gruposObj[row.programa][row.materia]) gruposObj[row.programa][row.materia] = [];
      gruposObj[row.programa][row.materia].push({...row.data, id:row.id});
    });
    localStorage.setItem("uan_grupos", JSON.stringify(gruposObj));
  }catch(err){
    console.error("No se pudo conectar con Supabase (grupos), se sigue usando la copia local:", err);
  }
}
async function empujarGruposASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("grupos").delete().neq("id", "___ninguno___");
    const filas = [];
    Object.keys(obj).forEach(programa=>{
      Object.keys(obj[programa]||{}).forEach(materia=>{
        (obj[programa][materia]||[]).forEach(g=>{
          const {id, ...resto} = g;
          filas.push({id, programa, materia, data:resto});
        });
      });
    });
    if(filas.length){
      const { error } = await supabaseClient.from("grupos").insert(filas);
      if(error) console.error("No se pudo guardar grupos en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar grupos en Supabase:", err); }
}

function getGrupos(){ return JSON.parse(localStorage.getItem("uan_grupos") || "{}"); }
function saveGrupos(obj){
  localStorage.setItem("uan_grupos", JSON.stringify(obj));
  empujarGruposASupabase(obj);
}

/* ----------------------------------------------------------------------
   MÓDULO 4: MATRÍCULAS Y NOTAS

   matriculas y estado_matriculas siguen el mismo patrón de "reemplazar
   toda la tabla" que los módulos anteriores (se guardan pocas veces:
   al matricular, al abrir/cerrar matrículas, al abrir nuevo semestre).

   notas es distinto a propósito: el docente califica ítem por ítem
   (un onchange por casilla), así que reemplazar TODA la tabla en cada
   tecla sería lento e innecesario. Por eso guardarNotaItem hace un
   upsert puntual de una sola fila (grupo_id + codigo), y solo el caso
   de "Abrir Nuevo Semestre" (que borra notas en bloque) usa el
   reemplazo completo vía saveNotas().
   ---------------------------------------------------------------------- */
async function sincronizarMatriculasNotasDesdeSupabase(){
  if(!supabaseClient) return;
  try{
    const [rMat, rEstado, rNotas] = await Promise.all([
      supabaseClient.from("matriculas").select("codigo,data"),
      supabaseClient.from("estado_matriculas").select("programa,abiertas"),
      supabaseClient.from("notas").select("grupo_id,codigo,data")
    ]);
    if(rMat.error) console.error("Error leyendo matriculas de Supabase:", rMat.error);
    if(rEstado.error) console.error("Error leyendo estado_matriculas de Supabase:", rEstado.error);
    if(rNotas.error) console.error("Error leyendo notas de Supabase:", rNotas.error);

    if(!rMat.error && rMat.data){
      const matObj = {};
      rMat.data.forEach(row=>{ matObj[row.codigo] = row.data; });
      localStorage.setItem("uan_matriculas", JSON.stringify(matObj));
    }
    if(!rEstado.error && rEstado.data){
      const estadoObj = {};
      rEstado.data.forEach(row=>{ estadoObj[row.programa] = row.abiertas; });
      localStorage.setItem("uan_estado_matriculas", JSON.stringify(estadoObj));
    }
    if(!rNotas.error && rNotas.data){
      const notasObj = {};
      rNotas.data.forEach(row=>{
        if(!notasObj[row.grupo_id]) notasObj[row.grupo_id] = {};
        notasObj[row.grupo_id][row.codigo] = row.data;
      });
      localStorage.setItem("uan_notas", JSON.stringify(notasObj));
    }
  }catch(err){
    console.error("No se pudo conectar con Supabase (matrículas/notas), se sigue usando la copia local:", err);
  }
}

async function empujarMatriculasASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("matriculas").delete().neq("codigo", "___ninguno___");
    const filas = Object.keys(obj).map(codigo=>({codigo, data:obj[codigo]}));
    if(filas.length){
      const { error } = await supabaseClient.from("matriculas").insert(filas);
      if(error) console.error("No se pudo guardar matriculas en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar matriculas en Supabase:", err); }
}
async function empujarEstadoMatriculasASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("estado_matriculas").delete().neq("programa", "___ninguno___");
    const filas = Object.keys(obj).map(programa=>({programa, abiertas: !!obj[programa]}));
    if(filas.length){
      const { error } = await supabaseClient.from("estado_matriculas").insert(filas);
      if(error) console.error("No se pudo guardar estado_matriculas en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar estado_matriculas en Supabase:", err); }
}
/* Reemplazo completo de la tabla notas — solo se usa en operaciones masivas
   (ej. limpiar notas de varios grupos al abrir nuevo semestre). */
async function empujarNotasASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("notas").delete().neq("id", "___ninguno___");
    const filas = [];
    Object.keys(obj).forEach(grupoId=>{
      Object.keys(obj[grupoId]||{}).forEach(codigo=>{
        filas.push({id: grupoId+"__"+codigo, grupo_id:grupoId, codigo, data:obj[grupoId][codigo]});
      });
    });
    if(filas.length){
      const { error } = await supabaseClient.from("notas").insert(filas);
      if(error) console.error("No se pudo guardar notas en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar notas en Supabase:", err); }
}
/* Upsert puntual de UNA sola fila (un estudiante, un grupo) — lo que usa
   guardarNotaItem en cada calificación, para no reemplazar toda la tabla. */
async function empujarFilaNotaASupabase(grupoId, codigo, itemsObj){
  if(!supabaseClient) return;
  try{
    const { error } = await supabaseClient.from("notas").upsert(
      { id: grupoId+"__"+codigo, grupo_id: grupoId, codigo, data: itemsObj },
      { onConflict: "id" }
    );
    if(error) console.error("No se pudo guardar la nota en Supabase:", error);
  }catch(err){ console.error("No se pudo guardar la nota en Supabase:", err); }
}

function getMatriculas(){ return JSON.parse(localStorage.getItem("uan_matriculas") || "{}"); }
function saveMatriculas(obj){
  localStorage.setItem("uan_matriculas", JSON.stringify(obj));
  empujarMatriculasASupabase(obj);
}

function getEstadoMatriculas(){ return JSON.parse(localStorage.getItem("uan_estado_matriculas") || "{}"); }
function saveEstadoMatriculas(obj){
  localStorage.setItem("uan_estado_matriculas", JSON.stringify(obj));
  empujarEstadoMatriculasASupabase(obj);
}

function getNotas(){ return JSON.parse(localStorage.getItem("uan_notas") || "{}"); }
function saveNotas(obj){
  localStorage.setItem("uan_notas", JSON.stringify(obj));
  empujarNotasASupabase(obj);
}

/* ----------------------------------------------------------------------
   MÓDULO 6: ASISTENCIA — { grupoId: { fecha: { codigo: 'presente'|'tardanza'|'falla' } } }
   Igual que notas, se marca clase por clase (un docente pasando lista),
   así que usa upsert puntual por fila en vez de reemplazar toda la tabla.
   ---------------------------------------------------------------------- */
async function sincronizarAsistenciaDesdeSupabase(){
  if(!supabaseClient) return;
  try{
    const { data, error } = await supabaseClient.from("asistencia").select("grupo_id,fecha,codigo,estado");
    if(error){ console.error("Error leyendo asistencia de Supabase:", error); return; }
    const obj = {};
    (data||[]).forEach(row=>{
      if(!obj[row.grupo_id]) obj[row.grupo_id] = {};
      if(!obj[row.grupo_id][row.fecha]) obj[row.grupo_id][row.fecha] = {};
      obj[row.grupo_id][row.fecha][row.codigo] = row.estado;
    });
    localStorage.setItem("uan_asistencia", JSON.stringify(obj));
  }catch(err){
    console.error("No se pudo conectar con Supabase (asistencia), se sigue usando la copia local:", err);
  }
}
/* Reemplazo completo — solo se usa en operaciones masivas (ej. Zona de Peligro). */
async function empujarAsistenciaASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("asistencia").delete().neq("id","___ninguno___");
    const filas = [];
    Object.keys(obj).forEach(grupoId=>{
      Object.keys(obj[grupoId]||{}).forEach(fecha=>{
        Object.keys(obj[grupoId][fecha]||{}).forEach(codigo=>{
          filas.push({id:grupoId+"__"+fecha+"__"+codigo, grupo_id:grupoId, fecha, codigo, estado:obj[grupoId][fecha][codigo]});
        });
      });
    });
    if(filas.length){
      const { error } = await supabaseClient.from("asistencia").insert(filas);
      if(error) console.error("No se pudo guardar asistencia en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar asistencia en Supabase:", err); }
}
/* Upsert (o borrado) puntual de UNA sola marca de asistencia — lo que usa
   marcarAsistencia en cada casilla, para no reemplazar toda la tabla. */
async function empujarFilaAsistenciaASupabase(grupoId, fecha, codigo, estado){
  if(!supabaseClient) return;
  try{
    const id = grupoId+"__"+fecha+"__"+codigo;
    if(!estado){
      const { error } = await supabaseClient.from("asistencia").delete().eq("id", id);
      if(error) console.error("No se pudo borrar la marca de asistencia en Supabase:", error);
      return;
    }
    const { error } = await supabaseClient.from("asistencia").upsert(
      { id, grupo_id:grupoId, fecha, codigo, estado }, { onConflict: "id" }
    );
    if(error) console.error("No se pudo guardar la asistencia en Supabase:", error);
  }catch(err){ console.error("No se pudo guardar la asistencia en Supabase:", err); }
}

function getAsistencia(){ return JSON.parse(localStorage.getItem("uan_asistencia") || "{}"); }
function saveAsistencia(obj){
  localStorage.setItem("uan_asistencia", JSON.stringify(obj));
  empujarAsistenciaASupabase(obj);
}
function marcarAsistencia(grupoId, fecha, codigo, estado){
  const asistencia = getAsistencia();
  if(!asistencia[grupoId]) asistencia[grupoId] = {};
  if(!asistencia[grupoId][fecha]) asistencia[grupoId][fecha] = {};
  if(estado){
    asistencia[grupoId][fecha][codigo] = estado;
  } else {
    delete asistencia[grupoId][fecha][codigo];
  }
  localStorage.setItem("uan_asistencia", JSON.stringify(asistencia));
  empujarFilaAsistenciaASupabase(grupoId, fecha, codigo, estado || null);
}
/* Nota de asistencia en escala 0-5: presente=1 punto, tardanza=0.5, falla=0,
   sobre el total de clases en las que el docente pasó lista para ese
   estudiante. Si nunca se ha pasado lista, devuelve null (no se puede calcular). */
function calcularNotaAsistencia(grupoId, codigo){
  const fechas = getAsistencia()[grupoId] || {};
  let puntos = 0, total = 0;
  Object.keys(fechas).forEach(fecha=>{
    const estado = fechas[fecha][codigo];
    if(estado===undefined) return;
    total++;
    if(estado==="presente") puntos += 1;
    else if(estado==="tardanza") puntos += 0.5;
  });
  if(total===0) return null;
  return puntos/total*5;
}

/* ----------------------------------------------------------------------
   MÓDULO 5 (final): ACTAS, EVALUACIÓN DOCENTE E HISTORIAL ACADÉMICO
   Todas de baja/media frecuencia (se guardan pocas veces por semestre,
   no en cada tecla como notas), así que usan el mismo patrón de
   "reemplazar toda la tabla" de los módulos 1-3.
   ---------------------------------------------------------------------- */
async function sincronizarActasEvaluacionHistorialDesdeSupabase(){
  if(!supabaseClient) return;
  try{
    const [rActas, rConfig, rEval, rEvalPend, rHist, rNivel, rNormal] = await Promise.all([
      supabaseClient.from("actas").select("grupo_id,data"),
      supabaseClient.from("config_evaluacion").select("grupo_id,data"),
      supabaseClient.from("evaluaciones_docente").select("grupo_id,codigo,data"),
      supabaseClient.from("evaluacion_pendiente").select("codigo,data"),
      supabaseClient.from("historial_academico").select("codigo,data"),
      supabaseClient.from("nivel_estudiante").select("codigo,nivel"),
      supabaseClient.from("normalidad_estudiante").select("codigo,data")
    ]);
    [rActas,rConfig,rEval,rEvalPend,rHist,rNivel,rNormal].forEach(r=>{
      if(r.error) console.error("Error leyendo módulo 5 de Supabase:", r.error);
    });

    if(!rActas.error && rActas.data){
      const obj={}; rActas.data.forEach(row=>{ obj[row.grupo_id]=row.data; });
      localStorage.setItem("uan_actas", JSON.stringify(obj));
    }
    if(!rConfig.error && rConfig.data){
      const obj={}; rConfig.data.forEach(row=>{ obj[row.grupo_id]=row.data; });
      localStorage.setItem("uan_config_evaluacion", JSON.stringify(obj));
    }
    if(!rEval.error && rEval.data){
      const obj={};
      rEval.data.forEach(row=>{
        if(!obj[row.grupo_id]) obj[row.grupo_id]={};
        obj[row.grupo_id][row.codigo]=row.data;
      });
      localStorage.setItem("uan_evaluaciones_docente", JSON.stringify(obj));
    }
    if(!rEvalPend.error && rEvalPend.data){
      const obj={}; rEvalPend.data.forEach(row=>{ obj[row.codigo]=row.data; });
      localStorage.setItem("uan_evaluacion_pendiente", JSON.stringify(obj));
    }
    if(!rHist.error && rHist.data){
      const obj={}; rHist.data.forEach(row=>{ obj[row.codigo]=row.data; });
      localStorage.setItem("uan_historial_academico", JSON.stringify(obj));
    }
    if(!rNivel.error && rNivel.data){
      const obj={}; rNivel.data.forEach(row=>{ obj[row.codigo]=row.nivel; });
      localStorage.setItem("uan_nivel_estudiante", JSON.stringify(obj));
    }
    if(!rNormal.error && rNormal.data){
      const obj={}; rNormal.data.forEach(row=>{ obj[row.codigo]=row.data; });
      localStorage.setItem("uan_normalidad_estudiante", JSON.stringify(obj));
    }
  }catch(err){
    console.error("No se pudo conectar con Supabase (actas/evaluación/historial), se sigue usando la copia local:", err);
  }
}

async function empujarActasASupabase(obj){
  if(!supabaseClient) return;

  try{
    const filas = Object.keys(obj).map(grupoId => ({
      grupo_id: grupoId,
      data: obj[grupoId]
    }));

    if(!filas.length) return;

    const { error } = await supabaseClient
      .from("actas")
      .upsert(filas, { onConflict: "grupo_id" });

    if(error){
      console.error("No se pudo guardar actas en Supabase:", error);
    }
  }catch(err){
    console.error("No se pudo guardar actas en Supabase:", err);
  }
}
async function empujarConfigEvaluacionASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("config_evaluacion").delete().neq("grupo_id","___ninguno___");
    const filas = Object.keys(obj).map(grupoId=>({grupo_id:grupoId, data:obj[grupoId]}));
    if(filas.length){
      const { error } = await supabaseClient.from("config_evaluacion").insert(filas);
      if(error) console.error("No se pudo guardar config_evaluacion en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar config_evaluacion en Supabase:", err); }
}
async function empujarEvaluacionesDocenteASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("evaluaciones_docente").delete().neq("id","___ninguno___");
    const filas = [];
    Object.keys(obj).forEach(grupoId=>{
      Object.keys(obj[grupoId]||{}).forEach(codigo=>{
        filas.push({id:grupoId+"__"+codigo, grupo_id:grupoId, codigo, data:obj[grupoId][codigo]});
      });
    });
    if(filas.length){
      const { error } = await supabaseClient.from("evaluaciones_docente").insert(filas);
      if(error) console.error("No se pudo guardar evaluaciones_docente en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar evaluaciones_docente en Supabase:", err); }
}
async function empujarEvaluacionPendienteASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("evaluacion_pendiente").delete().neq("codigo","___ninguno___");
    const filas = Object.keys(obj).map(codigo=>({codigo, data:obj[codigo]}));
    if(filas.length){
      const { error } = await supabaseClient.from("evaluacion_pendiente").insert(filas);
      if(error) console.error("No se pudo guardar evaluacion_pendiente en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar evaluacion_pendiente en Supabase:", err); }
}
async function empujarHistorialASupabase(obj){
  if(!supabaseClient) return;

  try{
    const filas = Object.keys(obj).map(codigo => ({
      codigo: codigo,
      data: obj[codigo]
    }));

    if(!filas.length) return;

    const { error } = await supabaseClient
      .from("historial_academico")
      .upsert(filas, { onConflict: "codigo" });

    if(error){
      console.error(
        "No se pudo guardar historial_academico en Supabase:",
        error
      );
    }
  }catch(err){
    console.error(
      "No se pudo guardar historial_academico en Supabase:",
      err
    );
  }
}async function empujarNivelesEstudiantesASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("nivel_estudiante").delete().neq("codigo","___ninguno___");
    const filas = Object.keys(obj).map(codigo=>({codigo, nivel:obj[codigo]}));
    if(filas.length){
      const { error } = await supabaseClient.from("nivel_estudiante").insert(filas);
      if(error) console.error("No se pudo guardar nivel_estudiante en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar nivel_estudiante en Supabase:", err); }
}
async function empujarNormalidadEstudiantesASupabase(obj){
  if(!supabaseClient) return;
  try{
    await supabaseClient.from("normalidad_estudiante").delete().neq("codigo","___ninguno___");
    const filas = Object.keys(obj).map(codigo=>({codigo, data:obj[codigo]}));
    if(filas.length){
      const { error } = await supabaseClient.from("normalidad_estudiante").insert(filas);
      if(error) console.error("No se pudo guardar normalidad_estudiante en Supabase:", error);
    }
  }catch(err){ console.error("No se pudo guardar normalidad_estudiante en Supabase:", err); }
}

function getConfigEvaluacion(){ return JSON.parse(localStorage.getItem("uan_config_evaluacion") || "{}"); }
function saveConfigEvaluacion(obj){
  localStorage.setItem("uan_config_evaluacion", JSON.stringify(obj));
  empujarConfigEvaluacionASupabase(obj);
}

function siguienteIdItemEvaluacion(){
  let n = parseInt(localStorage.getItem("uan_next_item_id") || "1", 10);
  localStorage.setItem("uan_next_item_id", String(n+1));
  return "item"+n;
}

function getActas(){ return JSON.parse(localStorage.getItem("uan_actas") || "{}"); }
function saveActas(obj){
  localStorage.setItem("uan_actas", JSON.stringify(obj));
  empujarActasASupabase(obj);
}
function getEvaluacionesDocente(){ return JSON.parse(localStorage.getItem("uan_evaluaciones_docente") || "{}"); }
function saveEvaluacionesDocente(obj){
  localStorage.setItem("uan_evaluaciones_docente", JSON.stringify(obj));
  empujarEvaluacionesDocenteASupabase(obj);
}
/* Bandera persistente: qué estudiantes quedaron con evaluación docente pendiente al
   cerrarse el semestre (obligatoria para poder matricular el siguiente). No depende de
   uan_evaluaciones_docente ni de uan_matriculas porque esas se limpian en cada semestre nuevo. */
function getEvaluacionPendiente(){ return JSON.parse(localStorage.getItem("uan_evaluacion_pendiente") || "{}"); }
function saveEvaluacionPendiente(obj){
  localStorage.setItem("uan_evaluacion_pendiente", JSON.stringify(obj));
  empujarEvaluacionPendienteASupabase(obj);
}

function getHistorial(){ return JSON.parse(localStorage.getItem("uan_historial_academico") || "{}"); }
function saveHistorial(obj){
  localStorage.setItem("uan_historial_academico", JSON.stringify(obj));
  empujarHistorialASupabase(obj);
}
function getNivelesEstudiantes(){ return JSON.parse(localStorage.getItem("uan_nivel_estudiante") || "{}"); }
function saveNivelesEstudiantes(obj){
  localStorage.setItem("uan_nivel_estudiante", JSON.stringify(obj));
  empujarNivelesEstudiantesASupabase(obj);
}
function getNormalidadEstudiantes(){ return JSON.parse(localStorage.getItem("uan_normalidad_estudiante") || "{}"); }
function saveNormalidadEstudiantes(obj){
  localStorage.setItem("uan_normalidad_estudiante", JSON.stringify(obj));
  empujarNormalidadEstudiantesASupabase(obj);
}


/* Promedio ponderado ACUMULADO (toda la carrera) de un estudiante, o null si aún no tiene notas. */
function calcularPromedioAcumulado(codigo){
  const historial = getHistorial()[codigo] || {};
  const todasEntradas = Object.keys(historial).map(m=>({
    materia:m, definitiva:historial[m].definitiva, creditos:historial[m].creditos
  }));
  if(todasEntradas.length===0) return null;
  const rp = calcularPromedioPonderado(todasEntradas);
  return rp ? rp.promedio : null;
}

/* Normalidad académica:
   - Promedio acumulado 3.2 a 5.0  -> Normal
   - Promedio acumulado 0.0 a 3.19 -> Condicional (máximo 12 créditos ese semestre)
   - 3 semestres CONSECUTIVOS por debajo de 3.2 -> PFU (Por Fuera de la Universidad), definitivo
   Se recalcula una sola vez por estudiante cada vez que se abre un nuevo semestre. */
function actualizarNormalidadEstudiante(codigo){
  const normalidad = getNormalidadEstudiantes();
  const actual = normalidad[codigo] || { estado:"Normal", semestresCondicional:0 };

  if(actual.estado === "PFU") return actual; // ya quedó por fuera, es definitivo

  const promedio = calcularPromedioAcumulado(codigo);
  if(promedio===null){
    // Todavía no tiene notas (recién ingresa): no se evalúa.
    normalidad[codigo] = actual;
    saveNormalidadEstudiantes(normalidad);
    return actual;
  }

  let nuevo;
  if(promedio >= 3.2){
    nuevo = { estado:"Normal", semestresCondicional:0 };
  } else {
    const semestresCondicional = (actual.semestresCondicional||0) + 1;
    nuevo = (semestresCondicional >= 3)
      ? { estado:"PFU", semestresCondicional }
      : { estado:"Condicional", semestresCondicional };
  }
  normalidad[codigo] = nuevo;
  saveNormalidadEstudiantes(normalidad);
  return nuevo;
}

function siguienteIdGrupo(){
  let n = parseInt(localStorage.getItem("uan_next_grupo_id") || "1", 10);
  localStorage.setItem("uan_next_grupo_id", String(n+1));
  return "grp"+n;
}

function listaMateriasPrograma(programaNombre){
  const data = getProgramas()[programaNombre];
  if(!data) return [];
  let materias=[];
  Object.values(data.niveles).forEach(arr=> materias = materias.concat(arr));
  return materias;
}

function listaElectivasPrograma(programaNombre){
  // Obsoleta: reemplazada por materiasElectivaSlots() y listaCursosElectivosPrograma()
  // desde que las electivas viven dentro del pensum. Se deja vacía por compatibilidad.
  return [];
}

function siguienteCodigo(){
  let n = parseInt(localStorage.getItem("uan_next_codigo") || "2224639", 10);
  localStorage.setItem("uan_next_codigo", String(n+1));
  return String(n);
}

/* Datos semilla, solo se crean la primera vez que se abre la app (o si
   Supabase todavía no tiene ninguna fila para esa tabla). */
function inicializarDatos(){
  if(Object.keys(getEstudiantes()).length===0){
    const est = {};
    est["2224637"] = {
      codigo:"2224637", password:"1",
      nombre:"PÉREZ GÓMEZ JUAN CAMILO",
      programa:"Sistemas",
      documento:"C-1000000000", expedida:"CIUDAD DEMO",
      nacimiento:"2003-01-01", lugarNacimiento:"CIUDAD DEMO",
      grupoSanguineo:"O+", estadoCivil:"SOLTERO(A)", genero:"MASCULINO",
      direccion:"CL 00 NO. 00 - 00 BARRIO DEMO", municipio:"CIUDAD DEMO",
      telefono:"3000000000", correo:"correo.demo@ejemplo.com",
      correoInstitucional:"juan2224637@correo.uan.edu.co",
      foto:"https://via.placeholder.com/90/1e5631/ffffff?text=JC"
    };
    est["2224638"] = {
      codigo:"2224638", password:"1",
      nombre:"JULIANA",
      programa:"Sistemas",
      documento:"C-1000000001", expedida:"CIUDAD DEMO",
      nacimiento:"2003-01-01", lugarNacimiento:"CIUDAD DEMO",
      grupoSanguineo:"O+", estadoCivil:"SOLTERO(A)", genero:"FEMENINO",
      direccion:"CL 00 NO. 00 - 00 BARRIO DEMO", municipio:"CIUDAD DEMO",
      telefono:"3000000000", correo:"correo.demo2@ejemplo.com",
      correoInstitucional:"2224638@correo.uan.edu.co",
      foto:"https://via.placeholder.com/90/1e5631/ffffff?text=J"
    };
    saveEstudiantes(est);
  }
  if(Object.keys(getProgramas()).length===0){
    const prog = {};
    prog["Sistemas"] = {
      sede:"UAN Sede Central",
      niveles:{ "Nivel 1":["Cálculo I","Introducción a la Programación"] }
    };
    savePrograms(prog);
  }
  if(!localStorage.getItem("uan_horarios")){
    saveHorarios({ "Sistemas": [] });
  }
  if(Object.keys(getDocentes()).length===0){
    saveDocentes({ "Sistemas": [] });
  }
  asegurarDocentesPredeterminados();
  if(Object.keys(getGrupos()).length===0){
    saveGrupos({ "Sistemas": {} });
  }
  if(Object.keys(getMatriculas()).length===0){
    saveMatriculas({});
  }
  if(Object.keys(getEstadoMatriculas()).length===0){
    saveEstadoMatriculas({ "Sistemas": false });
  }
  if(Object.keys(getNotas()).length===0){
    saveNotas({});
  }
  if(!localStorage.getItem("uan_next_codigo")){
    localStorage.setItem("uan_next_codigo","2224639");
  }
  migrarElectivasAntiguas();
}
Promise.all([
  sincronizarUsuariosDesdeSupabase(),
  sincronizarProgramasDesdeSupabase(),
  sincronizarGruposDesdeSupabase(),
  sincronizarMatriculasNotasDesdeSupabase(),
  sincronizarActasEvaluacionHistorialDesdeSupabase(),
  sincronizarAsistenciaDesdeSupabase()
]).finally(()=>{ datosListos = true; inicializarDatos(); });

/* Versiones anteriores guardaban las electivas como {nombreMateria: creditos}.
   Ahora son {nombreDeCupo: [{nombre, prerequisitos}, ...]}. Si queda algún dato
   viejo de esos por ahí, se limpia solo (no se puede migrar de verdad porque no
   sabemos a qué cupo pertenecía), para que no rompa nada. */
function migrarElectivasAntiguas(){
  const programas = getProgramas();
  let cambio = false;
  Object.keys(programas).forEach(nombrePrograma=>{
    const p = programas[nombrePrograma];
    if(p && p.electivas){
      Object.keys(p.electivas).forEach(clave=>{
        if(!Array.isArray(p.electivas[clave])){
          delete p.electivas[clave];
          cambio = true;
        }
      });
    }
  });
  if(cambio) savePrograms(programas);
}

function existeUsuarioDocente(usuario){
  const todos = getDocentes();
  return Object.values(todos).some(lista => (lista||[]).some(d=>d.usuario===usuario));
}

/* Todos los programas donde el docente logueado puede tener grupos: su carrera
   de origen, más cualquier otra carrera donde algún Director lo haya agregado. */
function programasDelDocente(){
  return [...new Set([usuarioActual.programa, ...(usuarioActual.programasAdicionales||[])])];
}

/* Docentes disponibles para dictar en una carrera: los que pertenecen a esa
   carrera de origen, más los de otras carreras que algún Director haya
   habilitado como docentes invitados de esta. */
function docentesDisponiblesPrograma(programaNombre){
  const todos = getDocentes();
  let lista = (todos[programaNombre]||[]).map(d=>({...d, programaOrigen:programaNombre}));
  Object.keys(todos).forEach(prog=>{
    if(prog===programaNombre) return;
    (todos[prog]||[]).forEach(d=>{
      if((d.programasAdicionales||[]).includes(programaNombre)){
        lista.push({...d, programaOrigen:prog});
      }
    });
  });
  return lista;
}

function asegurarDocentesPredeterminados(){
  const docentes = getDocentes();
  if(!docentes["Sistemas"]) docentes["Sistemas"] = [];

  if(!existeUsuarioDocente("jairo")){
    docentes["Sistemas"].push({
      id:"doc_jairo", nombre:"CARDOZO MENDOZA JAIRO ARMANDO",
      documento:"", especialidad:"", correo:"",
      usuario:"jairo", password:"1"
    });
  }
  if(!existeUsuarioDocente("silvia")){
    docentes["Sistemas"].push({
      id:"doc_silvia", nombre:"SILVIA",
      documento:"", especialidad:"", correo:"",
      usuario:"silvia", password:"1"
    });
  }
  saveDocentes(docentes);
}

/* ======================================================================
   SESIÓN
   ====================================================================== */
let usuarioActual = null; // {rol, programa?, codigo?}
let nivelCount = 0; // usado en formularios de pensum
let vistaEstudianteActual = 'datos';
let vistaDocenteActual = 'horario';

/* Solo estas vistas se refrescan solas en segundo plano: son de solo lectura
   (horario, matrícula, notas de consulta, avance). Las que tienen formularios
   activos (cambiar contraseña, evaluación docente, datos personales editables,
   notas del docente mientras califica) quedan afuera a propósito, para no
   borrarle a nadie lo que está escribiendo a mitad de camino. */
const VISTAS_ESTUDIANTE_AUTOREFRESH = ['horario','matricularMaterias','matricula','avance','asistencia'];
const VISTAS_DOCENTE_AUTOREFRESH = ['horario','evaluacion'];

function actualizarFechaHora(){
  const el=document.getElementById("fechaHora");
  if(el) el.textContent=new Date().toLocaleString();
}
setInterval(actualizarFechaHora,1000);
actualizarFechaHora();

function mostrarLogin(r){
  if(!datosListos){
    const inicio = document.getElementById("inicio");
    let aviso = document.getElementById("avisoCargando");
    if(!aviso){
      aviso = document.createElement("div");
      aviso.id = "avisoCargando";
      aviso.className = "aviso";
      aviso.style.marginTop = "15px";
      inicio.appendChild(aviso);
    }
    aviso.textContent = "Un momento, todavía se están cargando los datos. Intenta de nuevo en un segundo.";
    return;
  }
  usuarioActual = {rolCard:r};
  document.getElementById("inicio").style.display="none";
  document.getElementById("login").style.display="flex";
  document.getElementById("loginError").textContent = "";
}

function volverInicio(){
  document.getElementById("login").style.display="none";
  document.getElementById("inicio").style.display="flex";
}

function login(){
  let u=document.getElementById("user").value.trim();
  let p=document.getElementById("pass").value.trim();
  const rolCard = usuarioActual ? usuarioActual.rolCard : null;
  document.getElementById("loginError").textContent = "";

  if(rolCard==="admin"){
    const cuenta = getCuentasAdmin().find(c=>c.usuario===u && c.password===p);
    if(!cuenta){ document.getElementById("loginError").textContent = "Usuario o contraseña incorrectos"; return; }
    usuarioActual = {rol:cuenta.rol, programa:cuenta.programa || null};
    entrar();
    return;
  }

  if(rolCard==="doc"){
    const todosDocentes = getDocentes();
    let encontrado=null;
    Object.keys(todosDocentes).forEach(prog=>{
      const match = (todosDocentes[prog]||[]).find(d=>d.usuario===u && d.password===p);
      if(match) encontrado = {...match, programa:prog};
    });
    if(!encontrado){ document.getElementById("loginError").textContent = "Usuario o contraseña incorrectos"; return; }
    usuarioActual = {rol:"docente", id:encontrado.id, programa:encontrado.programa, nombre:encontrado.nombre, programasAdicionales:encontrado.programasAdicionales||[]};
    entrar();
    return;
  }

  if(rolCard==="est"){
    const estudiantes = getEstudiantes();
    const est = estudiantes[u];
    if(!est || est.password!==p){ document.getElementById("loginError").textContent = "Usuario o contraseña incorrectos"; return; }
    usuarioActual = {rol:"estudiante", codigo:u};
    entrar();
    return;
  }
}

function entrar(){
  document.getElementById("login").style.display="none";
  document.getElementById("dashboard").style.display="block";
  document.getElementById("user").value="";
  document.getElementById("pass").value="";
  renderSidebar();
}

function logout(){
  usuarioActual = null;
  document.getElementById("dashboard").style.display="none";
  document.getElementById("login").style.display="none";
  document.getElementById("inicio").style.display="flex";
  document.getElementById("contenido").innerHTML="<h2 class='panel-title'>Bienvenido</h2>";
}

function toggle(id){
  let sub=document.getElementById(id);
  sub.style.display=sub.style.display==="block"?"none":"block";
}

function cambiarFoto(){
  const btn = document.getElementById("btnCambiarFoto");
  const nota = document.createElement("div");
  nota.style.cssText = "font-size:11px;color:#9fb3c8;margin-top:4px";
  nota.textContent = "Función de cambio de foto: aquí se conectaría la subida de imagen a tu backend.";
  btn.insertAdjacentElement("afterend", nota);
  setTimeout(()=>nota.remove(), 4000);
}

/* ======================================================================
   CONFIRMACIÓN Y AVISOS DENTRO DE LA PÁGINA
   (en vez de confirm()/alert(), que quedan bloqueados en algunos
   navegadores/visores integrados de apps)
   ====================================================================== */
let accionPendiente = null;
let contenidoAntesDeConfirmar = "";

function pedirConfirmacion(mensaje, alConfirmar){
  accionPendiente = alConfirmar;
  contenidoAntesDeConfirmar = document.getElementById("contenido").innerHTML;
  document.getElementById("contenido").innerHTML = `
    <h2 class="panel-title">Confirmar Acción</h2>
    <div class="aviso aviso-error" style="max-width:520px">${mensaje}</div>
    <button onclick="confirmarAccionPendiente()">Sí, continuar</button>
    <button class="btn-secundario" onclick="cancelarAccionPendiente()">Cancelar</button>
  `;
}

function confirmarAccionPendiente(){
  const fn = accionPendiente;
  accionPendiente = null;
  if(fn) fn();
}

function cancelarAccionPendiente(){
  accionPendiente = null;
  document.getElementById("contenido").innerHTML = contenidoAntesDeConfirmar;
}

function irDocente(vista){
  vistaDocenteActual = vista;
  if(vista==='horario') renderHorarioDocente();
  else if(vista==='notas') renderNotasDocente();
  else if(vista==='asistencia') renderAsistenciaDocente();
  else if(vista==='evaluacion') renderEvaluacionRecibidaDocente();
  else if(vista==='password') renderCambiarPasswordDocente();
}

/* ======================================================================
   ACTUALIZACIÓN EN VIVO ENTRE PESTAÑAS (mismo navegador)
   Cuando Admisiones/Director/Coordinador guardan un cambio en otra pestaña
   del mismo navegador, esta pestaña (si es un Estudiante o un Docente con
   sesión abierta) refresca automáticamente lo que está viendo — pero solo
   si está en una de las vistas "seguras" (sin formulario a medio llenar).
   ====================================================================== */
window.addEventListener('storage', function(){
  if(!usuarioActual) return;
  if(usuarioActual.rol === 'estudiante' && VISTAS_ESTUDIANTE_AUTOREFRESH.includes(vistaEstudianteActual)){
    mostrarPanel(vistaEstudianteActual);
  } else if(usuarioActual.rol === 'docente' && VISTAS_DOCENTE_AUTOREFRESH.includes(vistaDocenteActual)){
    irDocente(vistaDocenteActual);
  }
});

/* ======================================================================
   ACTUALIZACIÓN EN VIVO ENTRE DISPOSITIVOS (celular, otro computador...)
   El evento "storage" de arriba SOLO funciona entre pestañas del MISMO
   navegador — no sirve para que el celular de un estudiante se entere de
   que el Coordinador acaba de generar horarios desde el computador de la
   universidad. Para eso, cada cierto tiempo se vuelve a descargar todo de
   Supabase (silenciosamente) y, si la pantalla actual es una vista
   "segura" de solo lectura, se refresca sola.
   ====================================================================== */
async function sincronizarTodoSilencioso(){
  await Promise.all([
    sincronizarUsuariosDesdeSupabase(),
    sincronizarProgramasDesdeSupabase(),
    sincronizarGruposDesdeSupabase(),
    sincronizarMatriculasNotasDesdeSupabase(),
    sincronizarActasEvaluacionHistorialDesdeSupabase(),
    sincronizarAsistenciaDesdeSupabase()
  ]);
}
setInterval(async ()=>{
  if(!usuarioActual || !datosListos) return;
  await sincronizarTodoSilencioso();
  if(usuarioActual.rol === 'estudiante' && VISTAS_ESTUDIANTE_AUTOREFRESH.includes(vistaEstudianteActual)){
    mostrarPanel(vistaEstudianteActual);
  } else if(usuarioActual.rol === 'docente' && VISTAS_DOCENTE_AUTOREFRESH.includes(vistaDocenteActual)){
    irDocente(vistaDocenteActual);
  }
  // Admisiones/Director/Coordinador no se refrescan solos (suelen tener
  // formularios abiertos), pero sus datos en segundo plano sí quedan al día.
}, 15000);

document.addEventListener('DOMContentLoaded', function(){
  const barra = document.querySelector(".sidebar");
  if(!barra) return;
  barra.addEventListener('click', function(e){
    if(window.innerWidth<=700 && (e.target.closest('.menu-item') || e.target.closest('.sub div'))){
      barra.classList.remove('mostrar-movil');
    }
  });
});

/* ======================================================================
   SIDEBAR DINÁMICO SEGÚN ROL
   ====================================================================== */
function renderSidebar(){
  const rolTexto=document.getElementById("rolTexto");
  const codigoTexto=document.getElementById("codigoTexto");
  const nombreTexto=document.getElementById("nombreTexto");
  const foto=document.getElementById("fotoPerfil");
  const menu=document.getElementById("menuDinamico");
  const btnFoto=document.getElementById("btnCambiarFoto");

  if(usuarioActual.rol==="estudiante"){
    const est=getEstudiantes()[usuarioActual.codigo];
    rolTexto.textContent="Rol: Estudiante";
    codigoTexto.textContent=est.codigo;
    nombreTexto.textContent=est.nombre;
    foto.src=est.foto;
    btnFoto.style.display="block";
    document.getElementById("topbarUsuario").textContent = "👤 " + est.nombre.split(" ")[0];

    menu.innerHTML=`
      <div class="menu-item" onclick="renderHomeDashboard()">🏠 Inicio <span>›</span></div>
      <div class="menu-item" onclick="mostrarPanel('datos')">Datos Personales <span>›</span></div>
      <div class="menu-item" onclick="mostrarPanel('password')">Cambiar Contraseña <span>›</span></div>
      <div class="menu-item" onclick="toggle('sub')">Servicios Académicos <span>›</span></div>
      <div class="sub" id="sub">
        <div onclick="mostrarPanel('avance')">Avance Plan Estudios</div>
        <div onclick="mostrarPanel('matricularMaterias')">Matricular Materias</div>
        <div onclick="mostrarPanel('horario')">Horario Actual - Otras operaciones</div>
        <div onclick="mostrarPanel('evaluacion')">Evaluación Docente</div>
        <div onclick="mostrarPanel('promedio')">Calcular Promedio Final Periodo</div>
        <div onclick="mostrarPanel('matricula')">Consulta de Matrícula y Notas</div>
        <div onclick="mostrarPanel('asistencia')">Mi Asistencia</div>
        <div onclick="mostrarPanel('seguimiento')">Seguimiento Académico Docente</div>
      </div>
      <div class="menu-item" onclick="mostrarPanel('grado')">Trabajo de grado <span>›</span></div>
    `;
    renderHomeDashboard();
    return;
  }

  btnFoto.style.display="none";
  foto.src="https://via.placeholder.com/90/1e5631/ffffff?text=UAN";

  if(usuarioActual.rol==="admisiones"){
    rolTexto.textContent="Rol: Admisiones";
    codigoTexto.textContent="";
    nombreTexto.textContent="Oficina de Admisiones";
    document.getElementById("topbarUsuario").textContent = "👤 Admisiones";
    menu.innerHTML=`
      <div class="menu-item" onclick="renderHomeDashboard()">🏠 Inicio <span>›</span></div>
      <div class="menu-item" onclick="renderMatricular()">Matricular Estudiante <span>›</span></div>
      <div class="menu-item" onclick="renderListaEstudiantes()">Lista de Estudiantes <span>›</span></div>
      <div class="menu-item" onclick="renderCrearCuentaAdmin()">Crear Director / Coordinador <span>›</span></div>
      <div class="menu-item" onclick="renderListaCuentasAdmin()">Ver Directores / Coordinadores <span>›</span></div>
      <div class="menu-item" onclick="renderZonaPeligro()" style="color:#ffb3b3">⚠️ Zona de Peligro <span>›</span></div>
    `;
    renderHomeDashboard();
  }
  else if(usuarioActual.rol==="director"){
    rolTexto.textContent="Rol: Director de Escuela";
    codigoTexto.textContent="Programa:";
    nombreTexto.textContent=usuarioActual.programa;
    document.getElementById("topbarUsuario").textContent = "👤 Director " + usuarioActual.programa;
    menu.innerHTML=`
      <div class="menu-item" onclick="renderHomeDashboard()">🏠 Inicio <span>›</span></div>
      <div class="menu-item" onclick="crearPensum()">Crear / Editar Plan de Estudios <span>›</span></div>
      <div class="menu-item" onclick="verPensumAdmin()">Ver Plan de Estudios <span>›</span></div>
      <div class="menu-item" onclick="renderCrearDocente()">Crear Docente <span>›</span></div>
      <div class="menu-item" onclick="renderListaDocentes()">Ver Docentes <span>›</span></div>
      <div class="menu-item" onclick="renderDocentesInvitados()">Docentes de Otras Carreras <span>›</span></div>
      <div class="menu-item" onclick="renderElectivas()">Materias Electivas <span>›</span></div>
    `;
    renderHomeDashboard();
  }
  else if(usuarioActual.rol==="coordinador"){
    rolTexto.textContent="Rol: Coordinador Académico";
    codigoTexto.textContent="Programa:";
    nombreTexto.textContent=usuarioActual.programa;
    document.getElementById("topbarUsuario").textContent = "👤 Coordinador " + usuarioActual.programa;
    menu.innerHTML=`
      <div class="menu-item" onclick="renderHomeDashboard()">🏠 Inicio <span>›</span></div>
      <div class="menu-item" onclick="renderProgramarMateria()">Programar Materia (Grupos) <span>›</span></div>
      <div class="menu-item" onclick="renderVerGrupos()">Ver Grupos Programados <span>›</span></div>
      <div class="menu-item" onclick="renderGestionMatriculas()">Abrir / Cerrar Matrículas <span>›</span></div>
      <div class="menu-item" onclick="renderInclusiones()">Inclusiones (cambios manuales) <span>›</span></div>
    `;
    renderHomeDashboard();
  }
  else if(usuarioActual.rol==="docente"){
    rolTexto.textContent="Rol: Docente";
    codigoTexto.textContent="Programa:";
    nombreTexto.textContent=usuarioActual.nombre + " (" + usuarioActual.programa + ")";
    document.getElementById("topbarUsuario").textContent = "👤 " + usuarioActual.nombre.split(" ")[0];
    menu.innerHTML=`
      <div class="menu-item" onclick="renderHomeDashboard()">🏠 Inicio <span>›</span></div>
      <div class="menu-item" onclick="irDocente('horario')">Horario Actual <span>›</span></div>
      <div class="menu-item" onclick="irDocente('notas')">Notas <span>›</span></div>
      <div class="menu-item" onclick="irDocente('asistencia')">Asistencia <span>›</span></div>
      <div class="menu-item" onclick="irDocente('evaluacion')">Evaluación Docente Recibida <span>›</span></div>
      <div class="menu-item" onclick="irDocente('password')">Cambiar Contraseña <span>›</span></div>
    `;
    renderHomeDashboard();
  }
}

/* ======================================================================
   DASHBOARD DE INICIO (tarjetas con ícono, una por sección)
   ====================================================================== */
function renderHomeDashboard(){
  let tiles = [];

  if(usuarioActual.rol==="estudiante"){
    tiles = [
      {icono:"📘", label:"Datos Personales", accion:"mostrarPanel('datos')"},
      {icono:"🔑", label:"Cambiar Contraseña", accion:"mostrarPanel('password')"},
      {icono:"📚", label:"Avance Plan Estudios", accion:"mostrarPanel('avance')"},
      {icono:"📝", label:"Matricular Materias", accion:"mostrarPanel('matricularMaterias')"},
      {icono:"🗓️", label:"Horario Actual", accion:"mostrarPanel('horario')"},
      {icono:"📊", label:"Matrícula y Notas", accion:"mostrarPanel('matricula')"},
      {icono:"📈", label:"Calcular Promedio", accion:"mostrarPanel('promedio')"},
      {icono:"👍", label:"Evaluación Docente", accion:"mostrarPanel('evaluacion')"},
      {icono:"✅", label:"Mi Asistencia", accion:"mostrarPanel('asistencia')"},
      {icono:"🎓", label:"Trabajo de Grado", accion:"mostrarPanel('grado')"}
    ];
  } else if(usuarioActual.rol==="docente"){
    tiles = [
      {icono:"🗓️", label:"Horario Actual", accion:"irDocente('horario')"},
      {icono:"📊", label:"Notas", accion:"irDocente('notas')"},
      {icono:"✅", label:"Asistencia", accion:"irDocente('asistencia')"},
      {icono:"⭐", label:"Evaluación Docente Recibida", accion:"irDocente('evaluacion')"},
      {icono:"🔑", label:"Cambiar Contraseña", accion:"irDocente('password')"}
    ];
  } else if(usuarioActual.rol==="admisiones"){
    tiles = [
      {icono:"📝", label:"Matricular Estudiante", accion:"renderMatricular()"},
      {icono:"👥", label:"Lista de Estudiantes", accion:"renderListaEstudiantes()"},
      {icono:"🏛️", label:"Crear Director/Coordinador", accion:"renderCrearCuentaAdmin()"},
      {icono:"📋", label:"Ver Directores/Coordinadores", accion:"renderListaCuentasAdmin()"},
      {icono:"⚠️", label:"Zona de Peligro", accion:"renderZonaPeligro()"}
    ];
  } else if(usuarioActual.rol==="director"){
    tiles = [
      {icono:"📚", label:"Crear/Editar Plan de Estudios", accion:"crearPensum()"},
      {icono:"📖", label:"Ver Plan de Estudios", accion:"verPensumAdmin()"},
      {icono:"🧑‍🏫", label:"Crear Docente", accion:"renderCrearDocente()"},
      {icono:"👥", label:"Ver Docentes", accion:"renderListaDocentes()"},
      {icono:"🔀", label:"Docentes de Otras Carreras", accion:"renderDocentesInvitados()"},
      {icono:"⭐", label:"Materias Electivas", accion:"renderElectivas()"}
    ];
  } else if(usuarioActual.rol==="coordinador"){
    tiles = [
      {icono:"🗓️", label:"Programar Materia", accion:"renderProgramarMateria()"},
      {icono:"👥", label:"Ver Grupos", accion:"renderVerGrupos()"},
      {icono:"🔓", label:"Abrir/Cerrar Matrículas", accion:"renderGestionMatriculas()"},
      {icono:"✏️", label:"Inclusiones", accion:"renderInclusiones()"}
    ];
  }

  const tilesHtml = tiles.map(t=>`
    <div class="dashboard-tile" onclick="${t.accion}">
      <span class="icono">${t.icono}</span>
      <div class="etiqueta">${t.label}</div>
    </div>
  `).join("");

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Inicio</h2>
    <div class="dashboard-grid">${tilesHtml}</div>
  `;
}

function toggleSidebarMobile(){
  document.querySelector(".sidebar").classList.toggle("mostrar-movil");
}

/* ======================================================================
   MÓDULO ADMISIONES
   ====================================================================== */
/* ======================================================================
   ADMISIONES — Crear Director de Escuela / Coordinador Académico
   Estas cuentas ya no están fijas en el código: Admisiones las crea para
   cualquier carrera (existente o nueva), lo que en la práctica es también
   cómo "nace" una carrera nueva en el sistema.
   ====================================================================== */
function renderCrearCuentaAdmin(mensaje){
  const programasSugeridos = listaProgramasConocidos();
  const datalist = programasSugeridos.map(p=>`<option value="${p}">`).join("");

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Crear Director / Coordinador</h2>
    ${mensaje ? `<div class="aviso">${mensaje}</div>` : ""}
    <p style="font-size:13px;color:#666;max-width:560px">
      Si escribes el nombre de una carrera que todavía no existe (ej: "Civil", "Mecánica"),
      queda creada automáticamente apenas guardes esta cuenta.
    </p>
    <div class="form-grid">
      <div>
        <label>Rol</label>
        <select id="ca_rol">
          <option value="director">Director de Escuela</option>
          <option value="coordinador">Coordinador Académico</option>
        </select>
      </div>
      <div>
        <label>Carrera / Programa</label>
        <input id="ca_programa" list="ca_programas_lista" placeholder="Ej: Sistemas, Civil, Mecánica">
        <datalist id="ca_programas_lista">${datalist}</datalist>
      </div>
      <div><label>Usuario</label><input id="ca_usuario"></div>
      <div><label>Contraseña</label><input id="ca_password" type="text"></div>
      <div class="full"><button onclick="guardarCuentaAdmin()">Crear Cuenta</button></div>
    </div>
  `;
}

function guardarCuentaAdmin(){
  const rol = document.getElementById("ca_rol").value;
  const programa = document.getElementById("ca_programa").value.trim();
  const usuario = document.getElementById("ca_usuario").value.trim();
  const password = document.getElementById("ca_password").value.trim();

  if(!programa || !usuario || !password){
    renderCrearCuentaAdmin(`<span style="color:#a83232">⚠ Carrera, usuario y contraseña son obligatorios.</span>`);
    return;
  }

  const cuentas = getCuentasAdmin();
  const yaExiste = cuentas.some(c=>c.usuario===usuario && c.password===password && c.rol===rol);
  if(yaExiste){
    document.getElementById("contenido").innerHTML = "";
    renderCrearCuentaAdmin(`<span style="color:#a83232">⚠ Ya existe una cuenta con ese usuario, contraseña y rol.</span>`);
    return;
  }

  cuentas.push({ usuario, password, rol, programa });
  saveCuentasAdmin(cuentas);

  renderCrearCuentaAdmin(`✅ Cuenta creada: <b>${rol==='director'?'Director de Escuela':'Coordinador Académico'}</b> de <b>${programa}</b> — usuario <b>${usuario}</b>.`);
}

/* ======================================================================
   ZONA DE PELIGRO — borrar datos del semestre para arrancar de cero,
   SIN tocar cuentas de estudiantes, docentes, directivos, ni el pensum.
   Requiere escribir una frase exacta + una segunda confirmación, porque
   es una acción irreversible sobre datos reales de la universidad.
   ====================================================================== */
function renderZonaPeligro(){
  document.getElementById("contenido").innerHTML = `
    <h2 class="panel-title">⚠️ Zona de Peligro</h2>
    <div class="aviso aviso-error" style="max-width:600px;text-align:left">
      Esta acción borra <b>TODO</b> lo relacionado con el semestre actual y el progreso
      académico de los estudiantes:
      <ul>
        <li>Grupos programados y horarios</li>
        <li>Matrículas y estado de matrículas (abiertas/cerradas)</li>
        <li>Notas</li>
        <li>Actas subidas</li>
        <li>Configuración de evaluación (ítems y pesos) de cada grupo</li>
        <li>Evaluaciones docentes recibidas</li>
        <li>Bloqueos por evaluación docente pendiente</li>
        <li>Historial académico, nivel y normalidad de cada estudiante</li>
        <li>Registros de asistencia</li>
      </ul>
      <b>NO se borran:</b> las cuentas de estudiantes, docentes, directores/coordinadores,
      ni el pensum / plan de estudios de los programas.
      <br><br>
      <b>Esta acción no se puede deshacer.</b>
    </div>
    <p style="font-size:13px;color:#666;max-width:560px">
      Para confirmar, escribe exactamente <b>BORRAR TODO</b> (en mayúsculas) en el cuadro y luego dale al botón.
    </p>
    <input id="confirmTextoBorron" placeholder="Escribe BORRAR TODO" style="max-width:300px">
    <button class="btn-peligro" onclick="intentarBorronYCuentaNueva()">Borrar y empezar de cero</button>
  `;
}

function intentarBorronYCuentaNueva(){
  const val = (document.getElementById("confirmTextoBorron").value || "").trim();
  if(val !== "BORRAR TODO"){
    renderZonaPeligro();
    document.getElementById("contenido").insertAdjacentHTML("afterbegin",
      `<div class="aviso aviso-error">Escribe exactamente <b>BORRAR TODO</b> (en mayúsculas) para confirmar.</div>`);
    return;
  }
  pedirConfirmacion(
    "Última confirmación: se va a borrar TODO el semestre actual y el progreso académico de los estudiantes (grupos, matrículas, notas, actas, evaluaciones, historial). Las cuentas de estudiantes, docentes, directivos y el pensum se conservan. Esta acción NO se puede deshacer. ¿Continuar?",
    borronYCuentaNueva
  );
}

function borronYCuentaNueva(){
  document.getElementById("contenido").innerHTML = `
    <h2 class="panel-title">Borrando…</h2>
    <p>Esto puede tardar unos segundos, no cierres esta pestaña.</p>
  `;

  const estadoInicial = {};
  Object.keys(getProgramas()).forEach(p=>{ estadoInicial[p] = false; });

  saveGrupos({});
  saveMatriculas({});
  saveEstadoMatriculas(estadoInicial);
  saveNotas({});
  saveActas({});
  saveConfigEvaluacion({});
  saveEvaluacionesDocente({});
  saveEvaluacionPendiente({});
  saveHistorial({});
  saveNivelesEstudiantes({});
  saveNormalidadEstudiantes({});
  saveAsistencia({});

  localStorage.setItem("uan_next_grupo_id","1");
  localStorage.setItem("uan_next_item_id","1");

  // Da un momento a que terminen de empujarse los borrados a Supabase
  // antes de mostrar el mensaje final (no bloquea, solo mejora la UX).
  setTimeout(()=>{
    document.getElementById("contenido").innerHTML = `
      <h2 class="panel-title">✅ Listo</h2>
      <div class="aviso">
        Se borraron los datos del semestre (grupos, matrículas, notas, actas, evaluaciones e historial).
        Las cuentas de estudiantes, docentes, directivos y el pensum se conservaron intactos.
      </div>
      <button onclick="renderHomeDashboard()">Volver al inicio</button>
    `;
  }, 1500);
}

function renderListaCuentasAdmin(){
  const cuentas = getCuentasAdmin().map((c,i)=>({...c, idx:i}));
  const directoresYCoordinadores = cuentas.filter(c=>c.rol==="director" || c.rol==="coordinador");

  let filas = directoresYCoordinadores.map(c=>`
    <tr>
      <td>${c.rol==='director'?'Director de Escuela':'Coordinador Académico'}</td>
      <td>${c.programa}</td>
      <td>${c.usuario}</td>
      <td class="acciones"><button class="btn-peligro" onclick="eliminarCuentaAdmin(${c.idx})">Eliminar</button></td>
    </tr>
  `).join("");
  if(!filas) filas = `<tr><td colspan="4">Aún no has creado Directores ni Coordinadores.</td></tr>`;

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Directores / Coordinadores</h2>
    <table>
      <tr><th>Rol</th><th>Carrera</th><th>Usuario</th><th>Acciones</th></tr>
      ${filas}
    </table>
  `;
}

function eliminarCuentaAdmin(idx){
  pedirConfirmacion("¿Eliminar esta cuenta? La persona ya no podrá entrar con esas credenciales.", function(){
    const cuentas = getCuentasAdmin();
    cuentas.splice(idx,1);
    saveCuentasAdmin(cuentas);
    renderListaCuentasAdmin();
  });
}

function renderMatricular(){
  const programas = Object.keys(getProgramas());
  const opcionesProgramas = programas.length
    ? programas.map(p=>`<option value="${p}">${p}</option>`).join("")
    : `<option value="Sistemas">Sistemas</option>`;

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Matricular Estudiante</h2>
    <div id="avisoMatricula"></div>
    <div class="form-grid">
      <div><label>Nombre completo</label><input id="m_nombre"></div>
      <div><label>Documento de identidad</label><input id="m_documento"></div>
      <div><label>Expedida en</label><input id="m_expedida"></div>
      <div><label>Fecha de nacimiento</label><input id="m_nacimiento" type="date"></div>
      <div><label>Lugar de nacimiento</label><input id="m_lugarNacimiento"></div>
      <div><label>Grupo sanguíneo</label><input id="m_grupoSanguineo" placeholder="O+"></div>
      <div><label>Estado civil</label>
        <select id="m_estadoCivil"><option>SOLTERO(A)</option><option>CASADO(A)</option><option>UNIÓN LIBRE</option></select>
      </div>
      <div><label>Género</label>
        <select id="m_genero"><option>MASCULINO</option><option>FEMENINO</option><option>OTRO</option></select>
      </div>
      <div><label>Dirección de residencia</label><input id="m_direccion"></div>
      <div><label>Municipio de residencia</label><input id="m_municipio"></div>
      <div><label>Teléfono</label><input id="m_telefono"></div>
      <div><label>Correo personal</label><input id="m_correo" type="email"></div>
      <div><label>Programa académico</label>
        <select id="m_programa">${opcionesProgramas}</select>
      </div>
      <div class="full"><button onclick="matricularEstudiante()">Matricular Estudiante</button></div>
    </div>
  `;
}

function matricularEstudiante(){
  const nombre=document.getElementById("m_nombre").value.trim();
  const documento=document.getElementById("m_documento").value.trim();
  const programa=document.getElementById("m_programa").value;

  if(!nombre || !documento){
    document.getElementById("avisoMatricula").innerHTML=`<div class="aviso aviso-error">Nombre y documento son obligatorios.</div>`;
    return;
  }

  const codigo = siguienteCodigo();
  const passwordInicial = "1";
  const correoInstitucional = codigo + "@correo.uan.edu.co";

  const estudiantes = getEstudiantes();
  estudiantes[codigo] = {
    codigo, password: passwordInicial,
    nombre: nombre.toUpperCase(),
    programa,
    documento,
    expedida:document.getElementById("m_expedida").value.trim(),
    nacimiento:document.getElementById("m_nacimiento").value,
    lugarNacimiento:document.getElementById("m_lugarNacimiento").value.trim(),
    grupoSanguineo:document.getElementById("m_grupoSanguineo").value.trim(),
    estadoCivil:document.getElementById("m_estadoCivil").value,
    genero:document.getElementById("m_genero").value,
    direccion:document.getElementById("m_direccion").value.trim(),
    municipio:document.getElementById("m_municipio").value.trim(),
    telefono:document.getElementById("m_telefono").value.trim(),
    correo:document.getElementById("m_correo").value.trim(),
    correoInstitucional,
    foto:"https://via.placeholder.com/90/1e5631/ffffff?text=" + encodeURIComponent(nombre.charAt(0))
  };
  saveEstudiantes(estudiantes);

  document.getElementById("avisoMatricula").innerHTML=`
    <div class="aviso">
      ✅ Estudiante matriculado con éxito.<br>
      <b>Código:</b> ${codigo} &nbsp; | &nbsp; <b>Contraseña inicial:</b> ${passwordInicial}<br>
      <b>Correo institucional:</b> ${correoInstitucional}<br>
      Entrégale estos datos al estudiante; podrá cambiar su contraseña desde su panel.
    </div>`;
  renderMatricular();
  document.getElementById("avisoMatricula").innerHTML = document.getElementById("avisoMatricula").innerHTML; // conservar aviso tras limpiar formulario
}

function renderListaEstudiantes(mensaje){
  const estudiantes = getEstudiantes();
  const codigos = Object.keys(estudiantes);

  let filas = codigos.map(cod=>{
    const e = estudiantes[cod];
    return `<tr>
      <td>${e.codigo}</td>
      <td>${e.nombre}</td>
      <td>${e.programa}</td>
      <td>${e.documento}</td>
      <td>${e.correoInstitucional}</td>
      <td class="acciones">
        <button class="btn-secundario" onclick="editarEstudianteAdmin('${cod}')">Editar Datos</button>
        <button class="btn-secundario" onclick="cambiarPasswordEstudianteAdmin('${cod}')">Cambiar Contraseña</button>
        <button class="btn-peligro" onclick="eliminarEstudiante('${cod}')">Eliminar</button>
      </td>
    </tr>`;
  }).join("");

  if(!filas) filas = `<tr><td colspan="6">No hay estudiantes matriculados aún.</td></tr>`;

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Lista de Estudiantes</h2>
    ${mensaje ? `<div class="aviso">${mensaje}</div>` : ""}
    <table>
      <tr><th>Código</th><th>Nombre</th><th>Programa</th><th>Documento</th><th>Correo institucional</th><th>Acciones</th></tr>
      ${filas}
    </table>
  `;
}

function eliminarEstudiante(codigo){
  pedirConfirmacion("¿Eliminar al estudiante " + codigo + "? Esta acción no se puede deshacer.", function(){
    const estudiantes = getEstudiantes();
    delete estudiantes[codigo];
    saveEstudiantes(estudiantes);
    renderListaEstudiantes();
  });
}

function editarEstudianteAdmin(codigo){
  const e = getEstudiantes()[codigo];
  const programas = Object.keys(getProgramas());
  const opcionesProgramas = programas.map(p=>`<option value="${p}" ${p===e.programa?"selected":""}>${p}</option>`).join("");

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Editar Estudiante — ${e.codigo}</h2>
    <div class="form-grid">
      <div><label>Código (no editable)</label><input class="bloqueado" value="${e.codigo}" disabled></div>
      <div><label>Correo institucional (no editable)</label><input class="bloqueado" value="${e.correoInstitucional}" disabled></div>
      <div><label>Nombre completo</label><input id="e_nombre" value="${e.nombre}"></div>
      <div><label>Documento</label><input id="e_documento" value="${e.documento}"></div>
      <div><label>Expedida en</label><input id="e_expedida" value="${e.expedida||""}"></div>
      <div><label>Fecha de nacimiento</label><input id="e_nacimiento" type="date" value="${e.nacimiento||""}"></div>
      <div><label>Lugar de nacimiento</label><input id="e_lugarNacimiento" value="${e.lugarNacimiento||""}"></div>
      <div><label>Grupo sanguíneo</label><input id="e_grupoSanguineo" value="${e.grupoSanguineo||""}"></div>
      <div><label>Dirección de residencia</label><input id="e_direccion" value="${e.direccion||""}"></div>
      <div><label>Municipio de residencia</label><input id="e_municipio" value="${e.municipio||""}"></div>
      <div><label>Teléfono</label><input id="e_telefono" value="${e.telefono||""}"></div>
      <div><label>Correo personal</label><input id="e_correo" value="${e.correo||""}"></div>
      <div><label>Programa académico</label><select id="e_programa">${opcionesProgramas}</select></div>
      <div class="full">
        <button onclick="guardarEdicionEstudiante('${codigo}')">Guardar Cambios</button>
        <button class="btn-secundario" onclick="renderListaEstudiantes()">Cancelar</button>
      </div>
    </div>
  `;
}

function guardarEdicionEstudiante(codigo){
  const estudiantes = getEstudiantes();
  const e = estudiantes[codigo];
  e.nombre=document.getElementById("e_nombre").value.trim().toUpperCase();
  e.documento=document.getElementById("e_documento").value.trim();
  e.expedida=document.getElementById("e_expedida").value.trim();
  e.nacimiento=document.getElementById("e_nacimiento").value;
  e.lugarNacimiento=document.getElementById("e_lugarNacimiento").value.trim();
  e.grupoSanguineo=document.getElementById("e_grupoSanguineo").value.trim();
  e.direccion=document.getElementById("e_direccion").value.trim();
  e.municipio=document.getElementById("e_municipio").value.trim();
  e.telefono=document.getElementById("e_telefono").value.trim();
  e.correo=document.getElementById("e_correo").value.trim();
  e.programa=document.getElementById("e_programa").value;

  saveEstudiantes(estudiantes);
  renderListaEstudiantes("✅ Cambios guardados para " + e.codigo + ".");
}

function cambiarPasswordEstudianteAdmin(codigo){
  const e = getEstudiantes()[codigo];
  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Cambiar Contraseña — ${e.codigo} · ${e.nombre}</h2>
    <div id="avisoPassAdmin"></div>
    <div class="form-grid">
      <div class="full"><label>Nueva contraseña</label><input id="ap_nueva" type="password"></div>
      <div class="full"><label>Confirmar nueva contraseña</label><input id="ap_confirmar" type="password"></div>
      <div class="full">
        <button onclick="guardarPasswordEstudianteAdmin('${codigo}')">Guardar Contraseña</button>
        <button class="btn-secundario" onclick="renderListaEstudiantes()">Cancelar</button>
      </div>
    </div>
  `;
}

function guardarPasswordEstudianteAdmin(codigo){
  const estudiantes = getEstudiantes();
  const e = estudiantes[codigo];
  const nueva=document.getElementById("ap_nueva").value;
  const confirmar=document.getElementById("ap_confirmar").value;

  if(!nueva || nueva!==confirmar){
    document.getElementById("avisoPassAdmin").innerHTML=`<div class="aviso aviso-error">La contraseña y su confirmación no coinciden.</div>`;
    return;
  }

  e.password = nueva;
  saveEstudiantes(estudiantes);
  renderListaEstudiantes("✅ Contraseña actualizada para " + e.codigo + ". Comunícasela al estudiante.");
}

/* ======================================================================
   MÓDULO DIRECTOR DE ESCUELA — Plan de Estudios (Pensum)
   ====================================================================== */
function crearPensum(){
  nivelCount=0;
  const programaNombre = usuarioActual.programa;
  const programas = getProgramas();
  const existente = programas[programaNombre];

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Crear / Editar Plan de Estudios — ${programaNombre}</h2>
    <div id="avisoPensum"></div>

    <label>Sede:</label>
    <select id="sede">
      <option>UAN Sede Central</option>
      <option>UAN Sede Norte</option>
      <option>UAN Sede Sur</option>
      <option>UAN Sede Oriente</option>
    </select>

    <div id="niveles"></div>

    <button class="add-btn" onclick="agregarNivel()">+ Agregar Nivel</button>
    <button onclick="guardarPensum()">Guardar Plan de Estudios</button>
  `;

  if(existente && existente.sede){
    document.getElementById("sede").value = existente.sede;
  }

  const creditosExistentes = (existente && existente.creditos) || {};
  const tiposExistentes = (existente && existente.tipos) || {};
  const prerequisitosExistentes = (existente && existente.prerequisitos) || {};

  // Si ya existe un pensum guardado para este programa, lo precargamos
  if(existente && existente.niveles){
    Object.keys(existente.niveles).forEach(nombreNivel=>{
      agregarNivel(existente.niveles[nombreNivel], creditosExistentes, tiposExistentes, prerequisitosExistentes);
    });
  }
}

function agregarNivel(materiasPrevias, creditosExistentes, tiposExistentes, prerequisitosExistentes){
  nivelCount++;
  let div=document.createElement("div");
  const filasIniciales = (materiasPrevias && materiasPrevias.length ? materiasPrevias : [""]);
  const creditos = creditosExistentes || {};
  const tipos = tiposExistentes || {};
  const prerequisitos = prerequisitosExistentes || {};
  const filasHtml = filasIniciales.map(m=>filaMateriaHtml(m, creditos[m], tipos[m], prerequisitos[m])).join("");

  div.innerHTML=`
    <h3>Nivel ${nivelCount}</h3>
    <table id="tabla${nivelCount}">
      <tr><th>Materia</th><th>Créditos</th><th>T/P</th><th>% Teórico</th><th>Requisitos</th><th>Electiva</th></tr>
      ${filasHtml}
    </table>
    <button onclick="agregarFila(${nivelCount})">+ Materia</button>
  `;
  document.getElementById("niveles").appendChild(div);
}

function filaMateriaHtml(nombre, creditosVal, tipoInfo, prereqArray){
  const cred = creditosVal!==undefined ? creditosVal : 3;
  const esTP = !!(tipoInfo && tipoInfo.tp);
  const esElectiva = !!(tipoInfo && tipoInfo.electiva);
  const pct = (tipoInfo && tipoInfo.pctTeorico!==undefined) ? tipoInfo.pctTeorico : 70;
  const prereqTexto = (prereqArray && prereqArray.length) ? prereqArray.join(", ") : "";
  return `<tr>
    <td><input value="${nombre||""}" placeholder="Ej: Electiva VII"></td>
    <td><input type="number" min="1" value="${cred}" style="width:70px"></td>
    <td style="text-align:center"><input type="checkbox" onchange="toggleTP(this)" ${esTP?"checked":""}></td>
    <td><input type="number" min="1" max="99" value="${pct}" style="width:70px" placeholder="% Teórico" ${esTP?"":"disabled"}></td>
    <td><input value="${prereqTexto}" placeholder="Ej: Cálculo I" style="width:140px"></td>
    <td style="text-align:center"><input type="checkbox" ${esElectiva?"checked":""} title="Es un cupo de electiva: el estudiante elige entre un catálogo de cursos"></td>
  </tr>`;
}

function toggleTP(chk){
  const pctInput = chk.closest("tr").cells[3].querySelector("input");
  pctInput.disabled = !chk.checked;
}

function agregarFila(n){
  let tabla=document.getElementById("tabla"+n);
  let row=tabla.insertRow();
  row.innerHTML = filaMateriaHtml("", 3, null, null);
}

function guardarPensum(){
  const programaNombre = usuarioActual.programa;
  let sede=document.getElementById("sede").value;

  if(nivelCount===0){
    document.getElementById("avisoPensum").innerHTML=`<div class="aviso aviso-error">Debes agregar al menos un nivel.</div>`;
    return;
  }

  let niveles={};
  let creditos={};
  let tipos={};
  let prerequisitos={};

  for(let i=1;i<=nivelCount;i++){
    let tabla=document.getElementById("tabla"+i);
    if(!tabla) continue;

    let materias=[];
    for(let j=1;j<tabla.rows.length;j++){
      let inputNombre=tabla.rows[j].cells[0].querySelector("input");
      let inputCreditos=tabla.rows[j].cells[1] ? tabla.rows[j].cells[1].querySelector("input") : null;
      let inputTP=tabla.rows[j].cells[2] ? tabla.rows[j].cells[2].querySelector("input") : null;
      let inputPct=tabla.rows[j].cells[3] ? tabla.rows[j].cells[3].querySelector("input") : null;
      let inputReq=tabla.rows[j].cells[4] ? tabla.rows[j].cells[4].querySelector("input") : null;
      let inputElectiva=tabla.rows[j].cells[5] ? tabla.rows[j].cells[5].querySelector("input") : null;
      if(inputNombre && inputNombre.value.trim()!==""){
        const nombreMateria = inputNombre.value.trim();
        materias.push(nombreMateria);
        creditos[nombreMateria] = inputCreditos ? (parseInt(inputCreditos.value,10) || 3) : 3;
        if(inputTP && inputTP.checked){
          tipos[nombreMateria] = { ...(tipos[nombreMateria]||{}), tp:true, pctTeorico: (inputPct ? (parseInt(inputPct.value,10)||70) : 70) };
        }
        if(inputElectiva && inputElectiva.checked){
          tipos[nombreMateria] = { ...(tipos[nombreMateria]||{}), electiva:true };
        }
        if(inputReq && inputReq.value.trim()!==""){
          const listaReq = inputReq.value.split(",").map(s=>s.trim()).filter(Boolean);
          if(listaReq.length>0) prerequisitos[nombreMateria] = listaReq;
        }
      }
    }

    if(materias.length>0){
      niveles["Nivel "+i]=materias;
    }
  }

  if(Object.keys(niveles).length===0){
    document.getElementById("avisoPensum").innerHTML=`<div class="aviso aviso-error">Debes agregar materias.</div>`;
    return;
  }

  // Validación suave: si un requisito no coincide con el nombre exacto de ninguna materia del pensum, avisamos.
  const todasLasMaterias = Object.values(niveles).flat();
  let requisitosNoEncontrados = [];
  Object.keys(prerequisitos).forEach(materia=>{
    prerequisitos[materia].forEach(req=>{
      if(!todasLasMaterias.includes(req)) requisitosNoEncontrados.push(`"${req}" (requisito de "${materia}")`);
    });
  });

  const programas = getProgramas();
  const electivasExistentes = (programas[programaNombre] && programas[programaNombre].electivas) || {};
  programas[programaNombre] = { sede, niveles, creditos, tipos, prerequisitos, electivas: electivasExistentes };
  savePrograms(programas);

  const avisoRequisitos = requisitosNoEncontrados.length
    ? `<br><span style="color:#a83232">⚠ Estos requisitos no coinciden con el nombre exacto de ninguna materia del pensum, revísalos: ${requisitosNoEncontrados.join(", ")}</span>`
    : "";

  document.getElementById("avisoPensum").innerHTML=`<div class="aviso">✅ Plan de estudios de ${programaNombre} guardado. Los estudiantes de este programa ya pueden verlo.${avisoRequisitos}</div>`;
}

function verPensumAdmin(){
  const programaNombre = usuarioActual.programa;
  const data = getProgramas()[programaNombre];

  if(!data){
    document.getElementById("contenido").innerHTML=`<h2 class="panel-title">Plan de Estudios — ${programaNombre}</h2><p>Aún no se ha creado el plan de estudios.</p>`;
    return;
  }

  const creditos = data.creditos || {};
  let html=`<h2 class="panel-title">Plan de Estudios — ${programaNombre}</h2><p><b>Sede:</b> ${data.sede}</p>`;
  for(let n in data.niveles){
    html+=`<h3>${n}</h3><table><tr><th>Materia</th><th>Créditos</th></tr>`;
    data.niveles[n].forEach(m=>{ html+=`<tr><td>${m}</td><td>${creditos[m]!==undefined?creditos[m]:"-"}</td></tr>`; });
    html+="</table>";
  }
  document.getElementById("contenido").innerHTML=html;
}

/* ======================================================================
   MÓDULO DIRECTOR DE ESCUELA — Docentes
   ====================================================================== */
function renderCrearDocente(){
  const programaNombre = usuarioActual.programa;
  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Crear Docente — ${programaNombre}</h2>
    <div id="avisoDocente"></div>
    <div class="form-grid">
      <div><label>Nombre completo</label><input id="d_nombre"></div>
      <div><label>Documento de identidad</label><input id="d_documento"></div>
      <div><label>Especialidad / Área</label><input id="d_especialidad"></div>
      <div><label>Correo de contacto</label><input id="d_correo" type="email"></div>
      <div class="full"><button onclick="guardarDocente()">Crear Docente</button></div>
    </div>
  `;
}

function guardarDocente(){
  const programaNombre = usuarioActual.programa;
  const nombre=document.getElementById("d_nombre").value.trim();
  const documento=document.getElementById("d_documento").value.trim();

  if(!nombre || !documento){
    document.getElementById("avisoDocente").innerHTML=`<div class="aviso aviso-error">Nombre y documento son obligatorios.</div>`;
    return;
  }

  const docentes = getDocentes();
  if(!docentes[programaNombre]) docentes[programaNombre]=[];

  const idNumero = siguienteIdDocente();
  const primerNombre = nombre.trim().split(" ")[0].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
  const usuario = primerNombre + idNumero;
  const passwordInicial = "1";

  docentes[programaNombre].push({
    id: "doc"+idNumero,
    nombre: nombre.toUpperCase(),
    documento,
    especialidad: document.getElementById("d_especialidad").value.trim(),
    correo: document.getElementById("d_correo").value.trim(),
    usuario,
    password: passwordInicial
  });
  saveDocentes(docentes);

  document.getElementById("avisoDocente").innerHTML=`
    <div class="aviso">
      ✅ Docente creado y disponible para el Coordinador Académico.<br>
      <b>Usuario:</b> ${usuario} &nbsp; | &nbsp; <b>Contraseña inicial:</b> ${passwordInicial}<br>
      Entrégale estos datos al docente para que ingrese por la tarjeta "DOCENTES".
    </div>`;
  renderCrearDocente();
}

function renderListaDocentes(mensaje){
  const programaNombre = usuarioActual.programa;
  const lista = (getDocentes()[programaNombre] || []);

  let filas = lista.map(d=>`
    <tr>
      <td>${d.nombre}</td><td>${d.documento}</td><td>${d.especialidad||"-"}</td><td>${d.usuario}</td>
      <td class="acciones">
        <button class="btn-secundario" onclick="editarDocente('${d.id}')">Editar</button>
        <button class="btn-secundario" onclick="cambiarPasswordDocenteDirector('${d.id}')">Cambiar Contraseña</button>
        <button class="btn-peligro" onclick="eliminarDocente('${d.id}')">Eliminar</button>
      </td>
    </tr>
  `).join("");

  if(!filas) filas = `<tr><td colspan="5">Aún no hay docentes registrados en ${programaNombre}.</td></tr>`;

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Docentes — ${programaNombre}</h2>
    ${mensaje ? `<div class="aviso">${mensaje}</div>` : ""}
    <table>
      <tr><th>Nombre</th><th>Documento</th><th>Especialidad</th><th>Usuario</th><th>Acciones</th></tr>
      ${filas}
    </table>
    <button class="add-btn" onclick="renderCrearDocente()">+ Agregar Docente</button>
  `;
}

function cambiarPasswordDocenteDirector(id){
  const programaNombre = usuarioActual.programa;
  const docentes = getDocentes();
  const d = docentes[programaNombre].find(x=>x.id===id);
  if(!d) return;

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Cambiar Contraseña — ${d.nombre}</h2>
    <div id="avisoPassDoc"></div>
    <div class="form-grid">
      <div class="full"><label>Nueva contraseña</label><input id="dp_nueva" type="password"></div>
      <div class="full"><label>Confirmar nueva contraseña</label><input id="dp_confirmar" type="password"></div>
      <div class="full">
        <button onclick="guardarPasswordDocenteDirector('${id}')">Guardar Contraseña</button>
        <button class="btn-secundario" onclick="renderListaDocentes()">Cancelar</button>
      </div>
    </div>
  `;
}

function guardarPasswordDocenteDirector(id){
  const programaNombre = usuarioActual.programa;
  const docentes = getDocentes();
  const d = docentes[programaNombre].find(x=>x.id===id);
  const nueva=document.getElementById("dp_nueva").value;
  const confirmar=document.getElementById("dp_confirmar").value;

  if(!nueva || nueva!==confirmar){
    document.getElementById("avisoPassDoc").innerHTML=`<div class="aviso aviso-error">La contraseña y su confirmación no coinciden.</div>`;
    return;
  }
  d.password = nueva;
  saveDocentes(docentes);
  renderListaDocentes("✅ Contraseña actualizada para " + d.nombre + ".");
}

function editarDocente(id){
  const programaNombre = usuarioActual.programa;
  const docentes = getDocentes();
  const d = docentes[programaNombre].find(x=>x.id===id);
  if(!d) return;

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Editar Docente — ${programaNombre}</h2>
    <div class="form-grid">
      <div><label>Nombre completo</label><input id="d_nombre" value="${d.nombre}"></div>
      <div><label>Documento de identidad</label><input id="d_documento" value="${d.documento}"></div>
      <div><label>Especialidad / Área</label><input id="d_especialidad" value="${d.especialidad||""}"></div>
      <div><label>Correo de contacto</label><input id="d_correo" value="${d.correo||""}"></div>
      <div class="full">
        <button onclick="guardarEdicionDocente('${id}')">Guardar Cambios</button>
        <button class="btn-secundario" onclick="renderListaDocentes()">Cancelar</button>
      </div>
    </div>
  `;
}

function guardarEdicionDocente(id){
  const programaNombre = usuarioActual.programa;
  const docentes = getDocentes();
  const d = docentes[programaNombre].find(x=>x.id===id);
  if(!d) return;

  d.nombre=document.getElementById("d_nombre").value.trim().toUpperCase();
  d.documento=document.getElementById("d_documento").value.trim();
  d.especialidad=document.getElementById("d_especialidad").value.trim();
  d.correo=document.getElementById("d_correo").value.trim();

  saveDocentes(docentes);
  renderListaDocentes("✅ Docente actualizado.");
}

function eliminarDocente(id){
  pedirConfirmacion("¿Eliminar este docente? Ya no aparecerá disponible al crear grupos nuevos.", function(){
    const programaNombre = usuarioActual.programa;
    const docentes = getDocentes();
    docentes[programaNombre] = docentes[programaNombre].filter(x=>x.id!==id);
    saveDocentes(docentes);
    renderListaDocentes();
  });
}

/* ======================================================================
   DIRECTOR — Docentes de Otras Carreras (invitar / quitar como docente
   invitado a alguien que ya pertenece a otra carrera, sin duplicar su
   identidad ni sus credenciales de acceso).
   ====================================================================== */
function renderDocentesInvitados(mensaje){
  const miPrograma = usuarioActual.programa;
  const todos = getDocentes();

  let filas = "";
  Object.keys(todos).forEach(prog=>{
    if(prog===miPrograma) return;
    (todos[prog]||[]).forEach(d=>{
      const yaInvitado = (d.programasAdicionales||[]).includes(miPrograma);
      filas += `<tr>
        <td>${d.nombre}</td>
        <td>${prog}</td>
        <td>${d.especialidad||"-"}</td>
        <td>
          ${yaInvitado
            ? `<button class="btn-peligro" onclick="quitarDocenteInvitado('${prog}','${d.id}')">Quitar de ${miPrograma}</button>`
            : `<button class="btn-secundario" onclick="agregarDocenteInvitado('${prog}','${d.id}')">+ Invitar a ${miPrograma}</button>`}
        </td>
      </tr>`;
    });
  });
  if(!filas) filas = `<tr><td colspan="4">No hay docentes en otras carreras todavía.</td></tr>`;

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Docentes de Otras Carreras — ${miPrograma}</h2>
    ${mensaje ? `<div class="aviso">${mensaje}</div>` : ""}
    <p style="font-size:13px;color:#666;max-width:600px">
      Invita a un docente que ya pertenece a otra carrera para que también pueda dictar materias de
      ${miPrograma}. No se duplica su cuenta: sigue entrando con el mismo usuario y contraseña, y el
      Coordinador de ${miPrograma} ya lo podrá elegir al programar grupos.
    </p>
    <table>
      <tr><th>Docente</th><th>Carrera de origen</th><th>Especialidad</th><th>Acciones</th></tr>
      ${filas}
    </table>
  `;
}

function agregarDocenteInvitado(programaOrigen, id){
  const miPrograma = usuarioActual.programa;
  const docentes = getDocentes();
  const d = (docentes[programaOrigen]||[]).find(x=>x.id===id);
  if(!d) return;
  d.programasAdicionales = d.programasAdicionales || [];
  if(!d.programasAdicionales.includes(miPrograma)) d.programasAdicionales.push(miPrograma);
  saveDocentes(docentes);
  renderDocentesInvitados(`✅ ${d.nombre} ya puede dictar materias de ${miPrograma}.`);
}

function quitarDocenteInvitado(programaOrigen, id){
  const miPrograma = usuarioActual.programa;
  pedirConfirmacion("¿Quitarle a este docente el permiso de dictar en " + miPrograma + "? Los grupos que ya tenga programados aquí no se borran solos; revísalos en \"Ver Grupos Programados\".", function(){
    const docentes = getDocentes();
    const d = (docentes[programaOrigen]||[]).find(x=>x.id===id);
    if(!d) return;
    d.programasAdicionales = (d.programasAdicionales||[]).filter(p=>p!==miPrograma);
    saveDocentes(docentes);
    renderDocentesInvitados(`✅ ${d.nombre} ya no aparece como docente disponible en ${miPrograma}.`);
  });
}

/* ======================================================================
   DIRECTOR — Materias Electivas
   La "Electiva" es un cupo normal DENTRO del pensum (con sus créditos y
   requisito de nivel, marcado con el checkbox "Electiva" al crear el plan
   de estudios). Aquí el Director carga, para cada cupo, el catálogo de
   cursos concretos entre los que el estudiante puede elegir uno — cada
   curso puede además tener su propio requisito adicional.
   ====================================================================== */
function materiasElectivaSlots(programaNombre){
  const data = getProgramas()[programaNombre] || {};
  const tipos = data.tipos || {};
  return listaMateriasPrograma(programaNombre).filter(m => tipos[m] && tipos[m].electiva);
}

function esMateriaElectivaSlot(programaNombre, materia){
  const data = getProgramas()[programaNombre] || {};
  return !!(data.tipos && data.tipos[materia] && data.tipos[materia].electiva);
}

function opcionesDeSlotDisponibles(programaNombre, slot, historial){
  const data = getProgramas()[programaNombre] || {};
  let opciones = (data.electivas && data.electivas[slot]) || [];
  if(!Array.isArray(opciones)) opciones = []; // formato viejo (nombre->créditos): se ignora
  return opciones.filter(op => (op.prerequisitos||[]).every(p => historial[p] && historial[p].aprobada));
}

/* Todos los nombres de cursos del catálogo, de cualquier cupo (para que el
   Coordinador les pueda programar grupos como a cualquier otra materia). */
function listaCursosElectivosPrograma(programaNombre){
  const data = getProgramas()[programaNombre] || {};
  const electivas = data.electivas || {};
  let cursos = [];
  Object.values(electivas).forEach(lista=>{
    if(!Array.isArray(lista)) return; // formato viejo (nombre->créditos): se ignora
    lista.forEach(op=>{ if(op && op.nombre) cursos.push(op.nombre); });
  });
  return [...new Set(cursos)];
}

function renderElectivas(mensaje){
  const programaNombre = usuarioActual.programa;
  const slots = materiasElectivaSlots(programaNombre);

  if(slots.length===0){
    document.getElementById("contenido").innerHTML=`
      <h2 class="panel-title">Materias Electivas — ${programaNombre}</h2>
      <div class="aviso aviso-error" style="max-width:600px">
        Todavía no tienes ninguna materia marcada como <b>Electiva</b> en el Plan de Estudios.
        Ve a "Crear/Editar Plan de Estudios", marca el checkbox "Electiva" en la materia que quieras que
        sea de libre elección (ej. "Electiva VII" en el Nivel 7, con sus créditos y su requisito de nivel),
        guarda, y vuelve aquí para cargarle el catálogo de cursos.
      </div>
    `;
    return;
  }

  const data = getProgramas()[programaNombre] || {};
  const opcionesSlot = slots.map(s=>`<option value="${s}">${s} (${(data.creditos||{})[s]||3} créditos)</option>`).join("");

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Materias Electivas — ${programaNombre}</h2>
    ${mensaje ? `<div class="aviso">${mensaje}</div>` : ""}
    <p style="font-size:13px;color:#666;max-width:600px">
      Cada materia marcada como "Electiva" en el pensum es un cupo, con sus propios créditos y requisito
      de nivel (eso ya lo definiste ahí). Aquí cargas el catálogo de cursos concretos entre los que el
      estudiante puede elegir uno para llenar ese cupo — cada curso puede tener, además, su propio requisito.
    </p>
    <div class="form-grid">
      <div class="full"><label>Cupo del pensum</label><select id="el_slot" onchange="renderCatalogoElectiva()">${opcionesSlot}</select></div>
    </div>
    <div id="catalogoElectiva"></div>
  `;
  renderCatalogoElectiva();
}

function renderCatalogoElectiva(){
  const programaNombre = usuarioActual.programa;
  const slot = document.getElementById("el_slot").value;
  const data = getProgramas()[programaNombre] || {};
  let opciones = (data.electivas && data.electivas[slot]) || [];
  if(!Array.isArray(opciones)) opciones = []; // formato viejo (nombre->créditos): se ignora

  const filas = opciones.map((op,i)=>`
    <tr>
      <td>${op.nombre}</td>
      <td>${(op.prerequisitos||[]).join(", ") || "-"}</td>
      <td class="acciones"><button class="btn-peligro" onclick="eliminarOpcionElectiva('${slot.replace(/'/g,"\\'")}',${i})">Eliminar</button></td>
    </tr>
  `).join("") || `<tr><td colspan="3">Aún no hay cursos cargados para este cupo.</td></tr>`;

  document.getElementById("catalogoElectiva").innerHTML = `
    <h3 style="margin-top:20px">Catálogo de "${slot}"</h3>
    <div class="form-grid">
      <div><label>Nombre del curso</label><input id="elc_nombre" placeholder="Ej: Inteligencia Artificial Aplicada"></div>
      <div><label>Requisito(s) propio(s) (opcional)</label><input id="elc_requisitos" placeholder="Ej: Programación II"></div>
      <div class="full"><button onclick="guardarOpcionElectiva('${slot.replace(/'/g,"\\'")}')">+ Agregar curso al catálogo</button></div>
    </div>
    <table>
      <tr><th>Curso</th><th>Requisito propio</th><th>Acciones</th></tr>
      ${filas}
    </table>
  `;
}

function guardarOpcionElectiva(slot){
  const programaNombre = usuarioActual.programa;
  const nombre = document.getElementById("elc_nombre").value.trim();
  const reqTexto = document.getElementById("elc_requisitos").value.trim();

  if(!nombre){
    renderCatalogoElectiva();
    return;
  }

  const programas = getProgramas();
  if(!programas[programaNombre].electivas) programas[programaNombre].electivas = {};
  if(!Array.isArray(programas[programaNombre].electivas[slot])) programas[programaNombre].electivas[slot] = []; // reemplaza formato viejo si lo hubiera

  const prerequisitos = reqTexto ? reqTexto.split(",").map(s=>s.trim()).filter(Boolean) : [];
  programas[programaNombre].electivas[slot].push({ nombre, prerequisitos });
  savePrograms(programas);

  renderElectivas(`✅ "${nombre}" agregado al catálogo de "${slot}".`);
  document.getElementById("el_slot").value = slot;
  renderCatalogoElectiva();
}

function eliminarOpcionElectiva(slot, idx){
  pedirConfirmacion("¿Eliminar este curso del catálogo? Si ya hay grupos o estudiantes matriculados en él, revísalo antes en \"Ver Grupos Programados\".", function(){
    const programaNombre = usuarioActual.programa;
    const programas = getProgramas();
    if(programas[programaNombre] && programas[programaNombre].electivas && programas[programaNombre].electivas[slot]){
      programas[programaNombre].electivas[slot].splice(idx,1);
      savePrograms(programas);
    }
    renderElectivas();
    document.getElementById("el_slot").value = slot;
    renderCatalogoElectiva();
  });
}

/* ======================================================================
   MÓDULO COORDINADOR ACADÉMICO — Programar Materia por Grupos
   El coordinador SOLO elige: materia, cantidad de grupos y docente por grupo.
   El horario (día/hora/salón) lo asigna el sistema automáticamente,
   evitando choques con las otras clases que ya dicta ese mismo docente.
   ====================================================================== */
let cantidadGruposGenerados = 0;

// Franjas horarias típicas que el sistema usa para armar el horario solo.
/* Franjas horarias que usa el generador automático. Se arman combinando pares de
   días con bloques de hora, para tener muchas más opciones que antes y así casi
   nunca quedarnos sin una franja libre que no le choque a nadie. */
const DIAS_PARES = [
  ["Lunes","Miércoles"], ["Martes","Jueves"], ["Lunes","Jueves"],
  ["Martes","Viernes"], ["Miércoles","Viernes"]
];
const FRANJAS_HORA = [
  ["06:00","08:00"], ["08:00","10:00"], ["10:00","12:00"],
  ["14:00","16:00"], ["16:00","18:00"], ["18:00","20:00"]
];
const PATRONES_HORARIO = [];
DIAS_PARES.forEach(par=>{
  FRANJAS_HORA.forEach(([hi,hf])=>{
    PATRONES_HORARIO.push({ dias:par, horaInicio:hi, horaFin:hf });
  });
});
["Viernes","Sábado"].forEach(dia=>{
  FRANJAS_HORA.forEach(([hi,hf])=>{
    PATRONES_HORARIO.push({ dias:[dia], horaInicio:hi, horaFin:hf });
  });
});

function minutosDesde(hhmm){
  const [h,m] = (hhmm||"0:0").split(":").map(Number);
  return (h||0)*60 + (m||0);
}

function bloquesSeSolapan(a, b){
  if(a.dia !== b.dia) return false;
  const aIni = minutosDesde(a.horaInicio), aFin = minutosDesde(a.horaFin);
  const bIni = minutosDesde(b.horaInicio), bFin = minutosDesde(b.horaFin);
  return aIni < bFin && bIni < aFin;
}

/* Todos los bloques que ya tiene ocupados un docente, en cualquier programa/materia. */
function bloquesOcupadosDocente(docente){
  const todosLosGrupos = getGrupos();
  let ocupados = [];
  Object.values(todosLosGrupos).forEach(porPrograma=>{
    Object.values(porPrograma).forEach(listaGrupos=>{
      listaGrupos.forEach(g=>{
        if(g.docente===docente){
          (g.bloques||[]).forEach(b=> ocupados.push(b));
        }
      });
    });
  });
  return ocupados;
}

function patronChocaConOcupados(patron, ocupados){
  return patron.dias.some(dia=>
    ocupados.some(o=>bloquesSeSolapan({dia,horaInicio:patron.horaInicio,horaFin:patron.horaFin}, o))
  );
}

/* Cuántos grupos (de cualquier programa/materia/docente) ya están usando exactamente
   esta franja. Sirve para repartir los grupos nuevos en horarios distintos en vez de
   amontonar todo en las primeras franjas de la lista — así, aunque dos materias las
   dicten docentes distintos, es menos probable que le choquen a un mismo estudiante. */
function contarUsoGlobalPatron(patron){
  const todosLosGrupos = getGrupos();
  let usos = 0;
  Object.values(todosLosGrupos).forEach(porPrograma=>{
    Object.values(porPrograma).forEach(listaGrupos=>{
      listaGrupos.forEach(g=>{
        (g.bloques||[]).forEach(b=>{
          if(patron.dias.includes(b.dia) && b.horaInicio===patron.horaInicio && b.horaFin===patron.horaFin){
            usos++;
          }
        });
      });
    });
  });
  return usos;
}

/* Elige automáticamente un horario libre para el docente. Entre las franjas que le
   sirven, prioriza la que menos usada esté en todo el sistema (para repartir mejor
   los horarios entre materias). Si el docente ya está ocupado en TODAS las franjas
   conocidas (caso extremo), elige la que menos choques tenga, para no dejar el
   grupo sin horario. */
function autogenerarBloques(docente, salon){
  const ocupados = bloquesOcupadosDocente(docente);
  const diasYaUsadosPorDocente = new Set(ocupados.map(o=>o.dia));
  let candidatos = PATRONES_HORARIO.filter(p=>!patronChocaConOcupados(p, ocupados));
  let patron;

  if(candidatos.length>0){
    candidatos.sort((a,b)=>{
      // 1) Prioridad principal: que el patrón meta al docente en días donde
      //    TODAVÍA no dicta nada esta semana. Así, si un mismo docente da
      //    varias materias, sus clases se reparten Lunes/Martes/Miércoles...
      //    en vez de amontonarse siempre en el mismo par de días a distinta hora.
      const nuevosDiasA = a.dias.filter(d=>!diasYaUsadosPorDocente.has(d)).length;
      const nuevosDiasB = b.dias.filter(d=>!diasYaUsadosPorDocente.has(d)).length;
      if(nuevosDiasB !== nuevosDiasA) return nuevosDiasB - nuevosDiasA;
      // 2) Entre empatados, la franja menos usada en todo el sistema (para
      //    repartir también entre distintos docentes/materias).
      return contarUsoGlobalPatron(a) - contarUsoGlobalPatron(b);
    });
    patron = candidatos[0];
  } else {
    let mejor=null, menosChoques=Infinity;
    PATRONES_HORARIO.forEach(p=>{
      const choques = p.dias.filter(dia=>
        ocupados.some(o=>bloquesSeSolapan({dia,horaInicio:p.horaInicio,horaFin:p.horaFin}, o))
      ).length;
      if(choques < menosChoques){ menosChoques = choques; mejor = p; }
    });
    patron = mejor;
  }

  return patron.dias.map(dia=>({dia, horaInicio:patron.horaInicio, horaFin:patron.horaFin, salon}));
}

function esMateriaTP(programaNombre, materia){
  const data = getProgramas()[programaNombre] || {};
  const info = (data.tipos||{})[materia];
  return !!(info && info.tp);
}

function renderProgramarMateria(){
  cantidadGruposGenerados = 0;
  const programaNombre = usuarioActual.programa;
  const materias = listaMateriasPrograma(programaNombre).filter(m=>!esMateriaElectivaSlot(programaNombre, m));
  const cursosElectivos = listaCursosElectivosPrograma(programaNombre);

  let opcionesMaterias = "";
  if(materias.length===0 && cursosElectivos.length===0){
    opcionesMaterias = `<option value="">(Aún no hay materias creadas por el Director de Escuela)</option>`;
  } else {
    if(materias.length){
      opcionesMaterias += `<optgroup label="Plan de estudios">${materias.map(m=>`<option value="${m}">${m}</option>`).join("")}</optgroup>`;
    }
    if(cursosElectivos.length){
      opcionesMaterias += `<optgroup label="Cursos de electivas">${cursosElectivos.map(m=>`<option value="${m}">${m}</option>`).join("")}</optgroup>`;
    }
  }

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Programar Materia (Grupos) — ${programaNombre}</h2>
    <div id="avisoGrupos"></div>
    <p style="font-size:13px;color:#666;max-width:560px">
      Elige la materia, cuántos grupos necesitas y qué docente dicta cada uno.
      El horario (día, hora y salón) lo asigna el sistema automáticamente, sin cruzarlo
      con las otras clases que ya dicta ese docente.
    </p>
    <div class="form-grid">
      <div><label>Materia</label><select id="pg_materia" onchange="actualizarCamposCantidadGrupos()">${opcionesMaterias}</select></div>
      <div id="pg_cantidad_contenedor"></div>
      <div class="full"><button class="btn-secundario" onclick="generarFilasGrupos()">Generar Grupos</button></div>
    </div>
    <div id="filasGrupos"></div>
  `;
  actualizarCamposCantidadGrupos();
}

function actualizarCamposCantidadGrupos(){
  const programaNombre = usuarioActual.programa;
  const materiaEl = document.getElementById("pg_materia");
  const cont = document.getElementById("pg_cantidad_contenedor");
  if(!materiaEl || !cont) return;
  const materia = materiaEl.value;
  if(materia && esMateriaTP(programaNombre, materia)){
    const info = (getProgramas()[programaNombre].tipos||{})[materia];
    cont.innerHTML = `
      <div><label>Grupos Teórico</label><input id="pg_cantidad_t" type="number" min="0" value="1"></div>
      <div><label>Grupos Práctico</label><input id="pg_cantidad_p" type="number" min="0" value="1"></div>
      <div class="full" style="font-size:12px;color:#666">
        Esta materia es Teórico/Práctico (${info.pctTeorico}% Teórico / ${100-info.pctTeorico}% Práctico definido por el Director).
        Cada componente necesita su propio grupo y docente (el horario lo asigna el sistema).
      </div>
    `;
  } else {
    cont.innerHTML = `<div><label>Cantidad de grupos</label><input id="pg_cantidad" type="number" min="1" value="1"></div>`;
  }
}

function tarjetaGrupoHtml(indice, nombreDefault, opcionesDocentes, componente){
  const badge = componente
    ? ` <span class="badge" style="background:${componente==='Teorico'?'#1e5631':'#2f5f8f'}">${componente==='Teorico'?'Teórico':'Práctico'}</span>`
    : "";
  return `
    <div class="grupo-card" style="border:1px solid #ccc;border-radius:8px;padding:12px;margin-bottom:12px;background:#fafafa">
      <h4 style="margin-top:0">${nombreDefault}${badge}</h4>
      ${componente ? `<input type="hidden" id="g_componente_${indice}" value="${componente}">` : ""}
      <div class="form-grid">
        <div><label>Nombre del grupo</label><input id="g_nombre_${indice}" value="${nombreDefault}"></div>
        <div><label>Docente</label><select id="g_docente_${indice}">${opcionesDocentes}</select></div>
        <div><label>Capacidad</label><input id="g_capacidad_${indice}" type="number" value="20"></div>
      </div>
      <p style="font-size:12px;color:#666;margin:8px 0 0 0">El horario y el salón se asignan automáticamente al guardar.</p>
    </div>
  `;
}

function generarFilasGrupos(){
  const programaNombre = usuarioActual.programa;
  const materia = document.getElementById("pg_materia").value;

  if(!materia){
    document.getElementById("avisoGrupos").innerHTML=`<div class="aviso aviso-error">No hay materias disponibles. Pídele al Director de Escuela que cree el plan de estudios.</div>`;
    return;
  }

  const docentes = docentesDisponiblesPrograma(programaNombre);
  const opcionesDocentes = docentes.length
    ? docentes.map(d=>`<option value="${d.nombre}">${d.nombre}${d.programaOrigen!==programaNombre ? " (invitado de "+d.programaOrigen+")" : ""}</option>`).join("")
    : `<option value="">(Aún no hay docentes creados)</option>`;

  if(esMateriaTP(programaNombre, materia)){
    const cantT = parseInt(document.getElementById("pg_cantidad_t").value,10) || 0;
    const cantP = parseInt(document.getElementById("pg_cantidad_p").value,10) || 0;
    if(cantT<1 || cantP<1){
      document.getElementById("avisoGrupos").innerHTML=`<div class="aviso aviso-error">Esta materia es Teórico/Práctico: necesitas al menos un grupo de cada componente.</div>`;
      return;
    }
    cantidadGruposGenerados = cantT + cantP;
    let html = `<h3>Grupos de: ${materia}</h3>`;
    let indice = 0;
    for(let i=1;i<=cantT;i++){ indice++; html += tarjetaGrupoHtml(indice, "Teórico "+i, opcionesDocentes, "Teorico"); }
    for(let i=1;i<=cantP;i++){ indice++; html += tarjetaGrupoHtml(indice, "Práctico "+i, opcionesDocentes, "Practico"); }
    html+=`<button onclick="guardarGrupos('${materia.replace(/'/g,"\\'")}')">Guardar Grupos (horario automático)</button>`;
    document.getElementById("filasGrupos").innerHTML = html;
    return;
  }

  const cantidad = parseInt(document.getElementById("pg_cantidad").value, 10);
  if(!cantidad || cantidad<1){
    document.getElementById("avisoGrupos").innerHTML=`<div class="aviso aviso-error">Indica una cantidad válida de grupos.</div>`;
    return;
  }
  cantidadGruposGenerados = cantidad;
  let html = `<h3>Grupos de: ${materia}</h3>`;
  for(let i=1;i<=cantidad;i++){ html += tarjetaGrupoHtml(i, "Grupo "+i, opcionesDocentes, null); }
  html+=`<button onclick="guardarGrupos('${materia.replace(/'/g,"\\'")}')">Guardar Grupos (horario automático)</button>`;
  document.getElementById("filasGrupos").innerHTML = html;
}

function guardarGrupos(materia){
  const programaNombre = usuarioActual.programa;
  const grupos = getGrupos();
  if(!grupos[programaNombre]) grupos[programaNombre]={};

  // Salón consecutivo simple, para que cada grupo nuevo no repita el mismo número.
  let contadorSalon = 100 + Object.values(grupos).reduce((tot,porPrograma)=>
    tot + Object.values(porPrograma).reduce((t2,lista)=>t2+lista.length,0), 0);

  let nuevosGrupos=[];
  for(let i=1;i<=cantidadGruposGenerados;i++){
    const docenteEl = document.getElementById("g_docente_"+i);
    if(!docenteEl) continue;
    const docente = docenteEl.value;
    if(!docente){
      document.getElementById("avisoGrupos").innerHTML=`<div class="aviso aviso-error">Cada grupo necesita un docente asignado. Pídele al Director de Escuela que cree docentes.</div>`;
      return;
    }

    contadorSalon++;
    const bloques = autogenerarBloques(docente, "Aula "+contadorSalon);

    const componenteEl = document.getElementById("g_componente_"+i);

    const nuevoGrupo = {
      id: siguienteIdGrupo(),
      grupo: document.getElementById("g_nombre_"+i).value.trim() || ("Grupo "+i),
      docente,
      capacidad: document.getElementById("g_capacidad_"+i).value,
      bloques,
      componente: componenteEl ? componenteEl.value : undefined
    };
    // Se guarda de inmediato (no solo al final) para que si el siguiente
    // grupo de este mismo lote tiene el mismo docente, autogenerarBloques()
    // ya vea este horario recién asignado y no se lo cruce.
    nuevosGrupos.push(nuevoGrupo);
    grupos[programaNombre][materia] = nuevosGrupos;
    saveGrupos(grupos);
  }

  const resumen = nuevosGrupos.map(g=>`${g.grupo} (${g.docente}): ${resumenBloques(g.bloques)}`).join("<br>");
  document.getElementById("avisoGrupos").innerHTML=`
    <div class="aviso">
      ✅ Se guardaron ${nuevosGrupos.length} grupo(s) de "${materia}" con horario automático:<br>
      <span style="font-size:13px">${resumen}</span><br>
      Ya son visibles para docentes, y los estudiantes de ${programaNombre} ya pueden matricularse en "Servicios Académicos → Matricular Materias".
    </div>`;
}

function resumenBloques(bloques){
  return (bloques||[]).map(b=>`${b.dia} ${b.horaInicio}-${b.horaFin}${b.salon?" ("+b.salon+")":""}`).join(" | ");
}


/* ======================================================================
   COORDINADOR — Abrir / Cerrar Matrículas
   ====================================================================== */
function estadoActasPrograma(programaNombre){
  const matriculas = getMatriculas();
  const actas = getActas();
  const gruposPrograma = getGrupos()[programaNombre] || {};
  const estudiantesPrograma = Object.values(getEstudiantes()).filter(e=>e.programa===programaNombre);

  let grupoIdsUsados = new Set();
  let hayRealizadas = false;
  estudiantesPrograma.forEach(e=>{
    const reg = matriculas[e.codigo];
    if(reg && reg.estado==="realizada"){
      hayRealizadas = true;
      Object.values(reg.materias||{}).forEach(val=>{
        // Materias Teórico/Práctico guardan {Teorico:id, Practico:id}; las simples guardan solo el id.
        if(val && typeof val==="object"){
          if(val.Teorico) grupoIdsUsados.add(val.Teorico);
          if(val.Practico) grupoIdsUsados.add(val.Practico);
        } else if(val){
          grupoIdsUsados.add(val);
        }
      });
    }
  });

  function detalleDeGrupo(gid){
    for(const materia of Object.keys(gruposPrograma)){
      const g = (gruposPrograma[materia]||[]).find(x=>x.id===gid);
      if(g) return { materia, grupo:g.grupo, docente:g.docente, componente:g.componente };
    }
    return { materia:"(grupo eliminado)", grupo:"-", docente:"-", componente:null };
  }

  const pendientesActas = Array.from(grupoIdsUsados)
    .filter(gid=> !actas[gid])
    .map(gid=>({ id:gid, ...detalleDeGrupo(gid) }));

  return { hayRealizadas, totalGrupos: grupoIdsUsados.size, pendientesActas };
}

function renderGestionMatriculas(mensaje){
  const programaNombre = usuarioActual.programa;
  const estado = getEstadoMatriculas();
  const abiertas = !!estado[programaNombre];

  const matriculas = getMatriculas();
  const estudiantesPrograma = Object.values(getEstudiantes()).filter(e=>e.programa===programaNombre);
  const pendientes = estudiantesPrograma.filter(e=> matriculas[e.codigo] && matriculas[e.codigo].estado==="solicitada").length;
  const generadas = estudiantesPrograma.filter(e=> matriculas[e.codigo] && matriculas[e.codigo].estado==="realizada").length;

  const infoActas = estadoActasPrograma(programaNombre);
  const semestreListoParaCerrar = !abiertas && infoActas.hayRealizadas && infoActas.pendientesActas.length===0;
  const hayActasPendientes = infoActas.hayRealizadas && infoActas.pendientesActas.length>0;

  const filasActasPendientes = infoActas.pendientesActas.map(p=>`
    <tr>
      <td>${p.materia}${p.componente ? " ("+(p.componente==='Teorico'?'Teórico':'Práctico')+")" : ""}</td>
      <td>${p.grupo}</td>
      <td>${p.docente}</td>
    </tr>
  `).join("");

  const evalPendientes = getEvaluacionPendiente();
  const estudiantesConPendiente = estudiantesPrograma.filter(e => evalPendientes[e.codigo] && evalPendientes[e.codigo].pendiente);
  const filasPendientesEval = estudiantesConPendiente.map(e => `
    <tr>
      <td>${e.nombre}</td>
      <td>${e.codigo}</td>
      <td style="text-align:left;font-size:12px">${(evalPendientes[e.codigo].detalle||[]).join(", ")}</td>
      <td><button class="btn-secundario" onclick="levantarBloqueoEvaluacion('${e.codigo}')">Levantar bloqueo</button></td>
    </tr>
  `).join("");

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Matrículas — ${programaNombre}</h2>
    ${mensaje ? `<div class="aviso">${mensaje}</div>` : ""}
    <div class="aviso ${abiertas?"":"aviso-error"}">
      Estado actual: <b>${abiertas ? "ABIERTAS" : "CERRADAS"}</b>
    </div>
    <p style="font-size:13px;color:#666;max-width:560px">
      Mientras estén <b>abiertas</b>, cada estudiante de ${programaNombre} puede <b>solicitar</b> materias una sola vez
      (sin elegir grupo). Cuando las cierres, usa <b>"Generar Horarios"</b> para que el sistema le asigne grupo a
      cada solicitud pendiente, cargue el horario del estudiante y llene la tabla de notas del docente.
    </p>
    <table style="max-width:400px">
      <tr><th>Solicitudes pendientes</th><td>${pendientes}</td></tr>
      <tr><th>Con horario ya generado</th><td>${generadas}</td></tr>
    </table>
    <button onclick="toggleMatriculas()">${abiertas ? "Cerrar Matrículas" : "Abrir Matrículas"}</button>
    ${!abiertas ? `<button class="btn-secundario" onclick="generarHorarios()" ${pendientes===0?"disabled":""}>Generar Horarios${pendientes? " ("+pendientes+" pendientes)":""}</button>` : ""}

    ${estudiantesConPendiente.length ? `
      <div class="aviso aviso-error" style="margin-top:20px">
        🔒 <b>${estudiantesConPendiente.length}</b> estudiante(s) no pueden matricular porque quedaron con
        evaluación docente <b>obligatoria</b> pendiente al cerrarse el semestre anterior.
      </div>
      <table style="max-width:700px">
        <tr><th>Estudiante</th><th>Código</th><th>Pendiente de</th><th></th></tr>
        ${filasPendientesEval}
      </table>
      <p style="font-size:12px;color:#666;max-width:560px">
        "Levantar bloqueo" habilita al estudiante a matricular sin exigirle la evaluación (úsalo solo en casos
        excepcionales, ya que la evaluación de ese semestre ya no está disponible para diligenciar).
      </p>
    ` : ""}


    ${hayActasPendientes ? `
      <div class="aviso aviso-error" style="margin-top:20px">
        ⚠️ Faltan <b>${infoActas.pendientesActas.length}</b> de <b>${infoActas.totalGrupos}</b> grupo(s) por subir actas
        ${!abiertas ? "antes de poder abrir un nuevo semestre" : "este periodo"}:
      </div>
      <table style="max-width:600px">
        <tr><th>Materia</th><th>Grupo</th><th>Docente</th></tr>
        ${filasActasPendientes}
      </table>
      <p style="font-size:12px;color:#666;max-width:560px">
        Las actas no se pueden generar solas: dependen de las notas reales que cada docente carga y confirma
        en "Notas y Actas". Usa esta lista para recordarle a cada uno que le falta subir la suya.
      </p>
    ` : ""}

    ${semestreListoParaCerrar ? `
      <div class="aviso" style="margin-top:20px">
        ✅ Todas las actas de ${programaNombre} ya fueron subidas. El semestre está listo para cerrarse.
      </div>
      <button class="btn-secundario" onclick="abrirNuevoSemestre()">🔄 Abrir Nuevo Semestre</button>
    ` : ""}
  `;
}

function levantarBloqueoEvaluacion(codigo){
  pedirConfirmacion("¿Confirmas que quieres habilitar a este estudiante para matricular sin exigirle la evaluación docente pendiente?", function(){
    const pendientesGlobal = getEvaluacionPendiente();
    delete pendientesGlobal[codigo];
    saveEvaluacionPendiente(pendientesGlobal);
    renderGestionMatriculas("✅ Bloqueo levantado. El estudiante ya puede solicitar matrícula.");
  });
}

function abrirNuevoSemestre(){
  const programaNombre = usuarioActual.programa;
  pedirConfirmacion(
    "Vas a cerrar el semestre actual de " + programaNombre + " y abrir uno nuevo. " +
    "Todos los estudiantes avanzarán de nivel (si perdieron alguna materia, la verán obligatoriamente y eso " +
    "les ocupará créditos del nuevo nivel). Los horarios y docentes de los grupos se mantienen igual, pero la " +
    "planilla de notas de cada grupo queda en blanco para este semestre (las notas y créditos ya publicados " +
    "quedan intactos para siempre en el historial de cada estudiante). ¿Continuar?",
    function(){
      const matriculas = getMatriculas();
      const estudiantesPrograma = Object.values(getEstudiantes()).filter(e=>e.programa===programaNombre);
      const dataPrograma = getProgramas()[programaNombre] || {niveles:{}};
      const nivelesKeys = Object.keys(dataPrograma.niveles || {});
      const nivelesEstudiantes = getNivelesEstudiantes();
      let nuevosPFU = [];

      estudiantesPrograma.forEach(e=>{
        if(matriculas[e.codigo] && matriculas[e.codigo].estado==="realizada"){
          // Antes de borrar la matrícula (y más abajo las evaluaciones del semestre),
          // se revisa si el estudiante evaluó a TODOS sus docentes. Si le falta alguna,
          // queda con evaluación obligatoria pendiente y no podrá volver a matricular
          // hasta que Coordinación Académica le levante el bloqueo manualmente.
          const entradasEval = entradasEvaluacionEstudiante(e.codigo, programaNombre);
          const evaluacionesActuales = getEvaluacionesDocente();
          const faltantes = entradasEval.filter(en => !(evaluacionesActuales[en.grupoId]||{})[e.codigo]);
          const pendientesGlobal = getEvaluacionPendiente();
          if(faltantes.length){
            pendientesGlobal[e.codigo] = {
              pendiente: true,
              detalle: faltantes.map(f => f.materia + (f.docente ? ` (${f.docente})` : ""))
            };
          } else {
            delete pendientesGlobal[e.codigo];
          }
          saveEvaluacionPendiente(pendientesGlobal);

          delete matriculas[e.codigo];
        }

        const estadoAnterior = (getNormalidadEstudiantes()[e.codigo]||{}).estado;
        const normalidad = actualizarNormalidadEstudiante(e.codigo);
        if(normalidad.estado === "PFU"){
          if(estadoAnterior !== "PFU") nuevosPFU.push(e.nombre);
          return; // queda por fuera de la universidad: no avanza de nivel, no vuelve a matricular
        }

        // Todos avanzan un nivel, hayan aprobado todo o no.
        const nivelActualIdx = obtenerNivelIndice(e.codigo, programaNombre, nivelesKeys);
        nivelesEstudiantes[e.codigo] = Math.min(nivelActualIdx + 1, nivelesKeys.length - 1);
      });
      saveMatriculas(matriculas);
      saveNivelesEstudiantes(nivelesEstudiantes);

      // Los grupos (horario, docente, capacidad) se reutilizan tal cual,
      // pero la planilla de notas de cada grupo debe quedar en blanco:
      // el docente NO debe tener que "Reabrir Actas" para poder calificar
      // a los estudiantes nuevos de este semestre. Los ítems de evaluación
      // (los % que ya definió el docente) sí se conservan para no repetir esa parte.
      const gruposPrograma = getGrupos()[programaNombre] || {};
      const actas = getActas();
      const notas = getNotas();
      const evaluaciones = getEvaluacionesDocente();
      Object.values(gruposPrograma).forEach(listaGrupos=>{
        listaGrupos.forEach(g=>{
          delete actas[g.id];
          delete notas[g.id];
          delete evaluaciones[g.id];
        });
      });
      saveActas(actas);
      saveNotas(notas);
      saveEvaluacionesDocente(evaluaciones);

      const estado = getEstadoMatriculas();
      estado[programaNombre] = true;
      saveEstadoMatriculas(estado);

      renderGestionMatriculas("✅ Nuevo semestre abierto para " + programaNombre + ". Todos los estudiantes avanzaron de nivel, las planillas de notas quedaron en blanco y ya pueden solicitar materias." +
        (nuevosPFU.length ? ` ⚠️ Quedaron por fuera de la universidad (PFU) por bajo rendimiento sostenido: ${nuevosPFU.join(", ")}.` : ""));
    }
  );
}

function toggleMatriculas(){
  const programaNombre = usuarioActual.programa;
  const estado = getEstadoMatriculas();
  estado[programaNombre] = !estado[programaNombre];
  saveEstadoMatriculas(estado);
  renderGestionMatriculas();
}

function contarOcupacionGrupo(grupoId, fuenteMatriculas){
  let count=0;
  const datos = fuenteMatriculas || getMatriculas();
  Object.values(datos).forEach(reg=>{
    if(reg && reg.materias){
      Object.values(reg.materias).forEach(val=>{
        if(val && typeof val==="object"){
          if(val.Teorico===grupoId || val.Practico===grupoId) count++;
        } else if(val===grupoId){
          count++;
        }
      });
    }
  });
  return count;
}

function elegirGrupoAutomatico(gruposMateria, fuenteMatriculas, bloquesOcupadosEstudiante){
  const candidatos = gruposMateria.map(g=>({
    g, ocupacion: contarOcupacionGrupo(g.id, fuenteMatriculas), capacidad: parseInt(g.capacidad || 20, 10)
  }));
  let disponibles = candidatos.filter(c=>c.ocupacion < c.capacidad);

  // Descarta los grupos que le chocarían al estudiante con una materia que
  // ya le quedó asignada en esta misma corrida de "Generar Horarios".
  if(bloquesOcupadosEstudiante && bloquesOcupadosEstudiante.length){
    const sinChoque = disponibles.filter(c =>
      !(c.g.bloques||[]).some(b => bloquesOcupadosEstudiante.some(o => bloquesSeSolapan(b,o)))
    );
    if(sinChoque.length>0) disponibles = sinChoque;
    else return null; // todos los grupos disponibles le chocan con otra materia suya
  }

  if(disponibles.length===0) return null; // todos los grupos están llenos
  disponibles.sort((a,b)=>a.ocupacion-b.ocupacion); // el menos ocupado primero
  return disponibles[0].g;
}

function generarHorarios(){
  const programaNombre = usuarioActual.programa;

  pedirConfirmacion("Esto asignará grupo a todos los estudiantes con matrícula pendiente en " + programaNombre + ". ¿Continuar?", function(){
    const matriculas = getMatriculas();
    const gruposPrograma = getGrupos()[programaNombre] || {};
    const estudiantesPrograma = Object.values(getEstudiantes()).filter(e=>e.programa===programaNombre);

    let procesados=0, conFaltantes=0;

    estudiantesPrograma.forEach(e=>{
      const reg = matriculas[e.codigo];
      if(reg && reg.estado==="solicitada"){
        let materiasAsignadas={};
        let sinCupo=[];
        let bloquesEstudiante=[]; // horario que se le va formando a ESTE estudiante en esta corrida

        (reg.materiasSolicitadas||[]).forEach(materia=>{
          const gruposMateria = gruposPrograma[materia] || [];
          if(esMateriaTP(programaNombre, materia)){
            const gruposT = gruposMateria.filter(g=>g.componente==="Teorico");
            const gruposP = gruposMateria.filter(g=>g.componente==="Practico");
            const gT = elegirGrupoAutomatico(gruposT, matriculas, bloquesEstudiante);
            if(gT) bloquesEstudiante = bloquesEstudiante.concat(gT.bloques||[]);
            const gP = gT ? elegirGrupoAutomatico(gruposP, matriculas, bloquesEstudiante) : null;
            if(gP) bloquesEstudiante = bloquesEstudiante.concat(gP.bloques||[]);
            if(gT && gP){ materiasAsignadas[materia] = { Teorico: gT.id, Practico: gP.id }; }
            else{ sinCupo.push(materia); }
          } else {
            const g = elegirGrupoAutomatico(gruposMateria, matriculas, bloquesEstudiante);
            if(g){
              materiasAsignadas[materia]=g.id;
              bloquesEstudiante = bloquesEstudiante.concat(g.bloques||[]);
            }
            else{ sinCupo.push(materia); }
          }
        });
        matriculas[e.codigo] = { estado:"realizada", materias:materiasAsignadas, materiasSinCupo:sinCupo, electivaSlotDe: reg.electivaSlotDe || {} };
        procesados++;
        if(sinCupo.length) conFaltantes++;
      }
    });

    saveMatriculas(matriculas);

    const resultado = `✅ Horarios generados para ${procesados} estudiante(s) de ${programaNombre}.` +
          (conFaltantes ? ` ⚠️ ${conFaltantes} estudiante(s) tuvieron alguna materia sin cupo o sin horario libre disponible (verifica si necesitas programar más grupos en otras franjas).` : "");
    renderGestionMatriculas(resultado);
  });
}

function renderVerGrupos(){
  const programaNombre = usuarioActual.programa;
  const grupos = getGrupos()[programaNombre] || {};

  let filas="";
  Object.keys(grupos).forEach(materia=>{
    grupos[materia].forEach(g=>{
      filas += `<tr>
        <td>${materia}${g.componente ? " ("+(g.componente==='Teorico'?'Teórico':'Práctico')+")" : ""}</td><td>${g.grupo}</td><td>${g.docente}</td>
        <td style="text-align:left">${resumenBloques(g.bloques)}</td><td>${g.capacidad||"-"}</td>
        <td class="acciones">
          <button class="btn-secundario" onclick="renderEditarHorarioGrupo('${materia}','${g.id}')">Editar Horario</button>
          <button class="btn-peligro" onclick="eliminarGrupo('${materia}','${g.id}')">Eliminar</button>
        </td>
      </tr>`;
    });
  });

  if(!filas) filas = `<tr><td colspan="6">Aún no hay grupos programados en ${programaNombre}.</td></tr>`;

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Grupos Programados — ${programaNombre}</h2>
    <table>
      <tr><th>Materia</th><th>Grupo</th><th>Docente</th><th>Horarios</th><th>Capacidad</th><th>Acciones</th></tr>
      ${filas}
    </table>
    <button class="add-btn" onclick="renderProgramarMateria()">+ Programar Materia</button>
  `;
}

/* ----------------------------------------------------------------------
   Editar día/hora/salón de un grupo ya programado. Valida que el nuevo
   horario no choque con otras clases del MISMO docente antes de guardar.
   ---------------------------------------------------------------------- */
let bloquesEdicionTemp = [];
const HORAS_EDICION_HORARIO = ["06:00","07:00","08:00","09:00","10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00","20:00","21:00","22:00"];
const DIAS_EDICION_HORARIO = ["Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];

function leerBloquesFormularioEdicion(){
  const filas = document.querySelectorAll("#tablaBloquesEdicion tr[data-fila]");
  const resultado = [];
  filas.forEach(fila=>{
    const i = fila.dataset.fila;
    resultado.push({
      dia: document.getElementById("ebd_"+i).value,
      horaInicio: document.getElementById("ebhi_"+i).value,
      horaFin: document.getElementById("ebhf_"+i).value,
      salon: document.getElementById("ebs_"+i).value.trim()
    });
  });
  return resultado;
}

function renderEditarHorarioGrupo(materia, grupoId){
  const programaNombre = usuarioActual.programa;
  const g = (getGrupos()[programaNombre][materia]||[]).find(x=>x.id===grupoId);
  if(!g){ renderVerGrupos(); return; }
  bloquesEdicionTemp = (g.bloques||[]).map(b=>({...b}));
  pintarFormularioEdicionHorario(materia, grupoId, g);
}

function pintarFormularioEdicionHorario(materia, grupoId, g, aviso){
  const filas = bloquesEdicionTemp.map((b,i)=>`
    <tr data-fila="${i}">
      <td><select id="ebd_${i}">${DIAS_EDICION_HORARIO.map(d=>`<option value="${d}" ${d===b.dia?'selected':''}>${d}</option>`).join("")}</select></td>
      <td><select id="ebhi_${i}">${HORAS_EDICION_HORARIO.map(h=>`<option value="${h}" ${h===b.horaInicio?'selected':''}>${h}</option>`).join("")}</select></td>
      <td><select id="ebhf_${i}">${HORAS_EDICION_HORARIO.map(h=>`<option value="${h}" ${h===b.horaFin?'selected':''}>${h}</option>`).join("")}</select></td>
      <td><input id="ebs_${i}" value="${b.salon||''}" placeholder="Ej: Aula 108"></td>
      <td><button class="btn-peligro" onclick="quitarBloqueEdicion('${materia}','${grupoId}',${i})">Quitar</button></td>
    </tr>
  `).join("");

  document.getElementById("contenido").innerHTML = `
    <h2 class="panel-title">Editar Horario — ${materia}${g.componente ? " ("+(g.componente==='Teorico'?'Teórico':'Práctico')+")" : ""} — Grupo ${g.grupo}</h2>
    <p style="font-size:13px;color:#666">Docente: <b>${g.docente}</b>. El sistema valida que el nuevo horario no choque con otra clase de este mismo docente antes de guardar.</p>
    ${aviso ? `<div class="aviso aviso-error" style="max-width:600px">${aviso}</div>` : ""}
    <table id="tablaBloquesEdicion" style="max-width:700px">
      <tr><th>Día</th><th>Hora inicio</th><th>Hora fin</th><th>Salón</th><th></th></tr>
      ${filas || '<tr><td colspan="5">Sin bloques. Agrega uno.</td></tr>'}
    </table>
    <button class="btn-secundario" onclick="agregarBloqueEdicion('${materia}','${grupoId}')">+ Agregar bloque</button>
    <br><br>
    <button onclick="guardarEdicionHorarioGrupo('${materia}','${grupoId}')">Guardar cambios</button>
    <button class="btn-secundario" onclick="renderVerGrupos()">Cancelar</button>
  `;
}

function agregarBloqueEdicion(materia, grupoId){
  bloquesEdicionTemp = leerBloquesFormularioEdicion();
  bloquesEdicionTemp.push({dia:"Lunes", horaInicio:"06:00", horaFin:"08:00", salon:""});
  const g = (getGrupos()[usuarioActual.programa][materia]||[]).find(x=>x.id===grupoId);
  pintarFormularioEdicionHorario(materia, grupoId, g);
}

function quitarBloqueEdicion(materia, grupoId, i){
  bloquesEdicionTemp = leerBloquesFormularioEdicion();
  bloquesEdicionTemp.splice(i,1);
  const g = (getGrupos()[usuarioActual.programa][materia]||[]).find(x=>x.id===grupoId);
  pintarFormularioEdicionHorario(materia, grupoId, g);
}

function guardarEdicionHorarioGrupo(materia, grupoId){
  const nuevosBloques = leerBloquesFormularioEdicion();
  const programaNombre = usuarioActual.programa;
  const grupos = getGrupos();
  const g = (grupos[programaNombre][materia]||[]).find(x=>x.id===grupoId);
  if(!g) return;

  for(const b of nuevosBloques){
    if(minutosDesde(b.horaInicio) >= minutosDesde(b.horaFin)){
      pintarFormularioEdicionHorario(materia, grupoId, g, "La hora de inicio debe ser menor que la hora de fin en todos los bloques.");
      return;
    }
  }

  // No choca con otras clases del MISMO docente (sin contar los bloques
  // que ya tenía este mismo grupo antes de la edición).
  const ocupadosOtros = bloquesOcupadosDocente(g.docente).filter(o=>
    !(g.bloques||[]).some(propio => propio.dia===o.dia && propio.horaInicio===o.horaInicio && propio.horaFin===o.horaFin && propio.salon===o.salon)
  );
  const choque = nuevosBloques.some(nb => ocupadosOtros.some(o=>bloquesSeSolapan(nb,o)));
  if(choque){
    pintarFormularioEdicionHorario(materia, grupoId, g, `⚠️ Ese horario le choca con otra clase que ya dicta ${g.docente}. Elige otro día u hora.`);
    return;
  }

  g.bloques = nuevosBloques;
  saveGrupos(grupos);
  renderVerGrupos();
}

function eliminarGrupo(materia, id){
  pedirConfirmacion("¿Eliminar este grupo?", function(){
    const programaNombre = usuarioActual.programa;
    const grupos = getGrupos();
    grupos[programaNombre][materia] = grupos[programaNombre][materia].filter(g=>g.id!==id);
    saveGrupos(grupos);
    renderVerGrupos();
  });
}

/* ======================================================================
   COORDINADOR — Inclusiones (cambios manuales de matrícula)
   Permite corregir a mano lo que la asignación automática no pudo resolver:
   cambiar de grupo/docente, quitar una materia o incluir una nueva.
   ====================================================================== */
function renderInclusiones(mensaje){
  const programaNombre = usuarioActual.programa;
  const matriculas = getMatriculas();
  const estudiantesPrograma = Object.values(getEstudiantes()).filter(e=>e.programa===programaNombre);
  const conMatricula = estudiantesPrograma.filter(e=> matriculas[e.codigo] && matriculas[e.codigo].estado==="realizada");

  const opciones = conMatricula.length
    ? conMatricula.map(e=>{
        const tieneSinCupo = (matriculas[e.codigo].materiasSinCupo||[]).length>0;
        return `<option value="${e.codigo}">${e.nombre} (${e.codigo})${tieneSinCupo ? " ⚠️ tiene materias sin cupo" : ""}</option>`;
      }).join("")
    : `<option value="">(Ningún estudiante tiene horario generado todavía)</option>`;

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Inclusiones — ${programaNombre}</h2>
    ${mensaje ? `<div class="aviso">${mensaje}</div>` : ""}
    <p style="font-size:13px;color:#666;max-width:600px">
      Corrige a mano la matrícula de un estudiante puntual: cámbialo de grupo o de docente, quítale una materia,
      o inclúyele una que le haya quedado sin cupo (o que necesite ver por excepción). El sistema sigue avisando
      si el cambio le cruza el horario con otra materia que ya tenga.
    </p>
    <div class="form-grid">
      <div class="full"><label>Estudiante</label><select id="inc_estudiante" onchange="renderDetalleInclusion()">${opciones}</select></div>
    </div>
    <div id="detalleInclusion"></div>
  `;
  if(conMatricula.length) renderDetalleInclusion();
}

function filaInclusion(materia, componente, grupoId, gruposPrograma){
  const lista = (gruposPrograma[materia]||[]).filter(g=> componente ? g.componente===componente : !g.componente);
  const gActual = grupoId ? lista.find(x=>x.id===grupoId) : null;
  const etiqueta = componente ? ` (${componente==='Teorico'?'Teórico':'Práctico'})` : "";
  const idSel = "inc_sel_"+materia.replace(/[^a-zA-Z0-9]/g,"")+"_"+(componente||"S");
  const matriculas = getMatriculas();

  const opcionesGrupos = lista.length
    ? lista.map(x=>{
        const ocupacion = contarOcupacionGrupo(x.id, matriculas);
        const capacidad = parseInt(x.capacidad||20,10);
        return `<option value="${x.id}" ${gActual && gActual.id===x.id?"selected":""}>${x.grupo} — ${x.docente} — ${resumenBloques(x.bloques)} (${ocupacion}/${capacidad})</option>`;
      }).join("")
    : `<option value="">(No hay grupos programados para esta materia/componente)</option>`;

  return `<tr>
    <td>${materia}${etiqueta}</td>
    <td>${gActual ? gActual.grupo : `<span style="color:#a83232">Sin asignar</span>`}</td>
    <td>${gActual ? gActual.docente : "-"}</td>
    <td style="text-align:left">${gActual ? resumenBloques(gActual.bloques) : "-"}</td>
    <td>
      <select id="${idSel}" style="width:auto">${opcionesGrupos}</select>
      <button class="btn-secundario" style="width:auto;padding:4px 10px;font-size:12px" onclick="cambiarGrupoInclusion('${materia.replace(/'/g,"\\'")}','${componente||""}','${idSel}')">Asignar</button>
      <button class="btn-peligro" style="width:auto;padding:4px 10px;font-size:12px" onclick="quitarMateriaInclusion('${materia.replace(/'/g,"\\'")}')">Quitar</button>
    </td>
  </tr>`;
}

function renderDetalleInclusion(){
  const programaNombre = usuarioActual.programa;
  const codigo = document.getElementById("inc_estudiante").value;
  const cont = document.getElementById("detalleInclusion");
  if(!codigo){ cont.innerHTML=""; return; }

  const reg = getMatriculas()[codigo];
  const gruposPrograma = getGrupos()[programaNombre] || {};

  let filas = "";
  Object.keys(reg.materias||{}).forEach(materia=>{
    const asign = reg.materias[materia];
    if(asign && typeof asign === "object"){
      filas += filaInclusion(materia, "Teorico", asign.Teorico, gruposPrograma);
      filas += filaInclusion(materia, "Practico", asign.Practico, gruposPrograma);
    } else {
      filas += filaInclusion(materia, null, asign, gruposPrograma);
    }
  });
  (reg.materiasSinCupo||[]).forEach(materia=>{
    if(esMateriaTP(programaNombre, materia)){
      filas += filaInclusion(materia, "Teorico", null, gruposPrograma);
      filas += filaInclusion(materia, "Practico", null, gruposPrograma);
    } else {
      filas += filaInclusion(materia, null, null, gruposPrograma);
    }
  });
  if(!filas) filas = `<tr><td colspan="5" style="color:#999">Este estudiante no tiene materias en su matrícula.</td></tr>`;

  const materiasPrograma = [...listaMateriasPrograma(programaNombre), ...listaCursosElectivosPrograma(programaNombre)];
  const materiasYaTiene = new Set(Object.keys(reg.materias||{}).concat(reg.materiasSinCupo||[]));
  const materiasParaAgregar = materiasPrograma.filter(m=>!materiasYaTiene.has(m));
  const opcionesAgregar = materiasParaAgregar.length
    ? materiasParaAgregar.map(m=>`<option value="${m}">${m}</option>`).join("")
    : `<option value="">(No hay más materias para agregar)</option>`;

  cont.innerHTML = `
    <div id="avisoInclusion"></div>
    <table>
      <tr><th>Materia</th><th>Grupo actual</th><th>Docente</th><th>Horario</th><th>Acciones</th></tr>
      ${filas}
    </table>
    <h3 style="margin-top:20px">Incluir una materia nueva</h3>
    <div class="form-grid">
      <div><label>Materia</label><select id="inc_materia_nueva">${opcionesAgregar}</select></div>
      <div class="full"><button class="btn-secundario" onclick="agregarMateriaInclusion()">+ Incluir materia</button></div>
    </div>
  `;
}

/* Todos los bloques que el estudiante ya tiene ocupados en su matrícula actual,
   excluyendo la propia materia/componente que se está por reasignar. */
function bloquesOcupadosEstudianteExcluyendo(reg, gruposPrograma, materiaExcluir, componenteExcluir){
  let bloques = [];
  Object.keys(reg.materias||{}).forEach(m=>{
    const val = reg.materias[m];
    if(val && typeof val==="object"){
      if(!(m===materiaExcluir && componenteExcluir==="Teorico") && val.Teorico){
        const g = (gruposPrograma[m]||[]).find(x=>x.id===val.Teorico);
        if(g) bloques = bloques.concat(g.bloques||[]);
      }
      if(!(m===materiaExcluir && componenteExcluir==="Practico") && val.Practico){
        const g = (gruposPrograma[m]||[]).find(x=>x.id===val.Practico);
        if(g) bloques = bloques.concat(g.bloques||[]);
      }
    } else if(val && m!==materiaExcluir){
      const g = (gruposPrograma[m]||[]).find(x=>x.id===val);
      if(g) bloques = bloques.concat(g.bloques||[]);
    }
  });
  return bloques;
}

function cambiarGrupoInclusion(materia, componente, idSel){
  const programaNombre = usuarioActual.programa;
  const codigo = document.getElementById("inc_estudiante").value;
  const nuevoGrupoId = document.getElementById(idSel).value;
  if(!nuevoGrupoId){
    document.getElementById("avisoInclusion").innerHTML = `<div class="aviso aviso-error">No hay grupos disponibles para asignar.</div>`;
    return;
  }

  const matriculas = getMatriculas();
  const reg = matriculas[codigo];
  if(!reg) return;
  if(!reg.materias) reg.materias = {};

  const gruposPrograma = getGrupos()[programaNombre] || {};
  const nuevoGrupo = (gruposPrograma[materia]||[]).find(x=>x.id===nuevoGrupoId);
  if(!nuevoGrupo) return;

  const yaEstabaAqui = componente
    ? (reg.materias[materia] && typeof reg.materias[materia]==="object" && reg.materias[materia][componente]===nuevoGrupoId)
    : (reg.materias[materia]===nuevoGrupoId);

  if(!yaEstabaAqui){
    const bloquesOcupados = bloquesOcupadosEstudianteExcluyendo(reg, gruposPrograma, materia, componente);
    const choca = (nuevoGrupo.bloques||[]).some(b=> bloquesOcupados.some(o=>bloquesSeSolapan(b,o)));
    if(choca){
      document.getElementById("avisoInclusion").innerHTML = `<div class="aviso aviso-error">⚠️ Ese horario se le cruza con otra materia que ya tiene matriculada. Elige otro grupo, o primero quítale la materia que choca.</div>`;
      return;
    }

    const ocupacion = contarOcupacionGrupo(nuevoGrupoId, matriculas);
    const capacidad = parseInt(nuevoGrupo.capacidad||20,10);
    if(ocupacion>=capacidad){
      document.getElementById("avisoInclusion").innerHTML = `<div class="aviso aviso-error">Ese grupo ya está lleno (${ocupacion}/${capacidad}). Elige otro o crea un grupo nuevo en "Programar Materia".</div>`;
      return;
    }
  }

  if(componente){
    if(!reg.materias[materia] || typeof reg.materias[materia] !== "object") reg.materias[materia] = {};
    reg.materias[materia][componente] = nuevoGrupoId;
  } else {
    reg.materias[materia] = nuevoGrupoId;
  }
  reg.materiasSinCupo = (reg.materiasSinCupo||[]).filter(m=>m!==materia);

  saveMatriculas(matriculas);
  renderInclusiones(`✅ "${materia}${componente?" ("+(componente==='Teorico'?'Teórico':'Práctico')+")":""}" quedó asignada a ${nuevoGrupo.grupo} (${nuevoGrupo.docente}).`);
  const sel = document.getElementById("inc_estudiante");
  if(sel){ sel.value = codigo; renderDetalleInclusion(); }
}

function quitarMateriaInclusion(materia){
  const codigo = document.getElementById("inc_estudiante").value;
  pedirConfirmacion(`¿Quitar "${materia}" de la matrícula de este estudiante? Se libera el cupo del grupo y la materia le queda pendiente para más adelante.`, function(){
    const matriculas = getMatriculas();
    const reg = matriculas[codigo];
    if(!reg) return;
    if(reg.materias) delete reg.materias[materia];
    reg.materiasSinCupo = (reg.materiasSinCupo||[]).filter(m=>m!==materia);
    saveMatriculas(matriculas);
    renderInclusiones(`✅ "${materia}" fue retirada de la matrícula.`);
    const sel = document.getElementById("inc_estudiante");
    if(sel){ sel.value = codigo; renderDetalleInclusion(); }
  });
}

function agregarMateriaInclusion(){
  const codigo = document.getElementById("inc_estudiante").value;
  const materia = document.getElementById("inc_materia_nueva").value;
  if(!materia){
    document.getElementById("avisoInclusion").innerHTML = `<div class="aviso aviso-error">Selecciona una materia.</div>`;
    return;
  }
  const matriculas = getMatriculas();
  const reg = matriculas[codigo];
  if(!reg) return;
  if(!reg.materias) reg.materias = {};
  if(reg.materias[materia] || (reg.materiasSinCupo||[]).includes(materia)){
    document.getElementById("avisoInclusion").innerHTML = `<div class="aviso aviso-error">El estudiante ya tiene esa materia.</div>`;
    return;
  }
  reg.materiasSinCupo = reg.materiasSinCupo || [];
  reg.materiasSinCupo.push(materia);
  saveMatriculas(matriculas);
  renderInclusiones(`"${materia}" quedó pendiente por asignarle grupo: elígelo abajo.`);
  const sel = document.getElementById("inc_estudiante");
  if(sel){ sel.value = codigo; renderDetalleInclusion(); }
}

/* ======================================================================
   GRILLA DE HORARIO (Hora x Día) — usada por Estudiante y Docente
   ====================================================================== */
function construirGrillaHorario(entradas){
  const bloques = ["6-7","7-8","8-9","9-10","10-11","11-12","12-13","13-14",
                    "14-15","15-16","16-17","17-18","18-19","19-20","20-21","21-22"];
  const dias = ["Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];

  function bloqueDeHora(horaStr){
    if(!horaStr) return null;
    const h=parseInt(horaStr.split(":")[0],10);
    const idx = h-6;
    return (idx>=0 && idx<bloques.length) ? idx : null;
  }

  let grid = {};
  entradas.forEach(e=>{
    const idxIni = bloqueDeHora(e.horaInicio);
    if(idxIni===null) return;
    let idxFin = bloqueDeHora(e.horaFin);
    if(idxFin===null || idxFin<=idxIni) idxFin = idxIni+1;
    for(let idx=idxIni; idx<idxFin; idx++){
      if(idx>=bloques.length) break;
      if(!grid[idx]) grid[idx]={};
      if(!grid[idx][e.dia]) grid[idx][e.dia]=[];
      grid[idx][e.dia].push(`<b>${e.materia}</b> (${e.grupo})${e.salon?" — "+e.salon:""}`);
    }
  });

  let html = `<table><tr><th>Hora</th>${dias.map(d=>`<th>${d}</th>`).join("")}</tr>`;
  bloques.forEach((b,idx)=>{
    html+=`<tr><td>${b}</td>`;
    dias.forEach(d=>{
      const celdas = (grid[idx] && grid[idx][d]) ? grid[idx][d] : [];
      html+=`<td>${celdas.map(c=>`<div>${c}</div>`).join("")}</td>`;
    });
    html+="</tr>";
  });
  html+="</table>";
  return html;
}

/* ======================================================================
   MÓDULO ESTUDIANTE
   ====================================================================== */
function mostrarPanel(tipo){
  vistaEstudianteActual = tipo;
  const cont=document.getElementById("contenido");

  if(tipo==="datos"){ renderDatosPersonalesEstudiante(); return; }
  if(tipo==="password"){ renderCambiarPasswordEstudiante(); return; }
  if(tipo==="avance"){ renderAvancePlanEstudiante(); return; }
  if(tipo==="matricularMaterias"){ renderMatricularMaterias(); return; }
  if(tipo==="horario"){ renderHorarioEstudiante(); return; }

  if(tipo==="promedio"){ renderPromedioEstudiante(); return; }
  if(tipo==="matricula"){ renderConsultaMatriculaNotas(); return; }
  if(tipo==="evaluacion"){ renderEvaluacionDocente(); return; }
  if(tipo==="asistencia"){ renderAsistenciaEstudiante(); return; }

  const paneles={
    seguimiento:`<h2 class="panel-title">Seguimiento Académico Docente</h2><p>Aquí se mostrará el seguimiento académico realizado por los docentes.</p>`,
    grado:`<h2 class="panel-title">Trabajo de Grado</h2><p>Aquí se mostrará el estado del proceso de trabajo de grado.</p>`
  };
  cont.innerHTML = paneles[tipo] || "<h2 class='panel-title'>Sección no disponible</h2>";
}

function renderDatosPersonalesEstudiante(){
  const e = getEstudiantes()[usuarioActual.codigo];

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Datos Personales</h2>
    <div id="avisoDatos"></div>
    <div class="form-grid">
      <div><label>Código (no editable)</label><input class="bloqueado" value="${e.codigo}" disabled></div>
      <div><label>Correo institucional (no editable)</label><input class="bloqueado" value="${e.correoInstitucional}" disabled></div>
      <div><label>Nombre completo</label><input id="p_nombre" value="${e.nombre}"></div>
      <div><label>Documento</label><input id="p_documento" value="${e.documento}"></div>
      <div><label>Programa</label><input class="bloqueado" value="${e.programa}" disabled></div>
      <div><label>Fecha de nacimiento</label><input id="p_nacimiento" type="date" value="${e.nacimiento||""}"></div>
      <div><label>Estado civil</label>
        <select id="p_estadoCivil">
          <option ${e.estadoCivil==="SOLTERO(A)"?"selected":""}>SOLTERO(A)</option>
          <option ${e.estadoCivil==="CASADO(A)"?"selected":""}>CASADO(A)</option>
          <option ${e.estadoCivil==="UNIÓN LIBRE"?"selected":""}>UNIÓN LIBRE</option>
        </select>
      </div>
      <div><label>Dirección de residencia</label><input id="p_direccion" value="${e.direccion||""}"></div>
      <div><label>Municipio de residencia</label><input id="p_municipio" value="${e.municipio||""}"></div>
      <div><label>Teléfono</label><input id="p_telefono" value="${e.telefono||""}"></div>
      <div><label>Correo personal</label><input id="p_correo" value="${e.correo||""}"></div>
      <div class="full"><button onclick="guardarDatosEstudiante()">Guardar Cambios</button></div>
    </div>
  `;
}

function guardarDatosEstudiante(){
  const estudiantes = getEstudiantes();
  const e = estudiantes[usuarioActual.codigo];

  e.nombre=document.getElementById("p_nombre").value.trim().toUpperCase();
  e.documento=document.getElementById("p_documento").value.trim();
  e.nacimiento=document.getElementById("p_nacimiento").value;
  e.estadoCivil=document.getElementById("p_estadoCivil").value;
  e.direccion=document.getElementById("p_direccion").value.trim();
  e.municipio=document.getElementById("p_municipio").value.trim();
  e.telefono=document.getElementById("p_telefono").value.trim();
  e.correo=document.getElementById("p_correo").value.trim();
  // codigo y correoInstitucional NUNCA se modifican aquí

  saveEstudiantes(estudiantes);
  document.getElementById("nombreTexto").textContent = e.nombre;
  document.getElementById("avisoDatos").innerHTML = `<div class="aviso">✅ Datos actualizados correctamente.</div>`;
}

function renderCambiarPasswordEstudiante(){
  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Cambiar Contraseña</h2>
    <div id="avisoPassword"></div>
    <div class="form-grid">
      <div class="full"><label>Contraseña actual</label><input id="pw_actual" type="password"></div>
      <div class="full"><label>Nueva contraseña</label><input id="pw_nueva" type="password"></div>
      <div class="full"><label>Confirmar nueva contraseña</label><input id="pw_confirmar" type="password"></div>
      <div class="full"><button onclick="cambiarPasswordEstudiante()">Actualizar Contraseña</button></div>
    </div>
  `;
}

function cambiarPasswordEstudiante(){
  const estudiantes = getEstudiantes();
  const e = estudiantes[usuarioActual.codigo];
  const actual=document.getElementById("pw_actual").value;
  const nueva=document.getElementById("pw_nueva").value;
  const confirmar=document.getElementById("pw_confirmar").value;

  if(actual!==e.password){
    document.getElementById("avisoPassword").innerHTML=`<div class="aviso aviso-error">La contraseña actual no es correcta.</div>`;
    return;
  }
  if(!nueva || nueva!==confirmar){
    document.getElementById("avisoPassword").innerHTML=`<div class="aviso aviso-error">La nueva contraseña y su confirmación no coinciden.</div>`;
    return;
  }

  e.password = nueva;
  saveEstudiantes(estudiantes);
  document.getElementById("avisoPassword").innerHTML=`<div class="aviso">✅ Contraseña actualizada correctamente.</div>`;
  document.getElementById("pw_actual").value="";
  document.getElementById("pw_nueva").value="";
  document.getElementById("pw_confirmar").value="";
}

function renderAvancePlanEstudiante(){
  const e = getEstudiantes()[usuarioActual.codigo];
  const data = getProgramas()[e.programa];

  if(!data){
    document.getElementById("contenido").innerHTML=`<h2 class="panel-title">Avance Plan de Estudios</h2><p>El Director de Escuela aún no ha publicado el plan de estudios de ${e.programa}.</p>`;
    return;
  }

  const creditosPrograma = data.creditos || {};
  const historial = getHistorial()[e.codigo] || {};

  let creditosAprobados = 0;
  let creditosTotalesPrograma = 0;
  let tablasNiveles = "";

  for(let n in data.niveles){
    tablasNiveles += `<h3>${n}</h3><table><tr><th>Materia</th><th>Créditos</th><th>Estado</th></tr>`;
    data.niveles[n].forEach(m=>{
      const creditosMateria = creditosPrograma[m]!==undefined ? creditosPrograma[m] : 3;
      creditosTotalesPrograma += creditosMateria;

      const registro = historial[m];
      let estadoHtml = `<span style="color:#999">Sin cursar</span>`;

      if(registro){
        const color = registro.aprobada ? "#1e5631" : "#a83232";
        const fondo = registro.aprobada ? "#eaf7ea" : "#fdecea";
        const texto = registro.aprobada ? "Aprobada" : "Reprobada";
        estadoHtml = `<span style="background:${fondo};color:${color};font-weight:bold;padding:3px 8px;border-radius:6px">${texto} — ${registro.definitiva.toFixed(1)}</span>`;
        if(registro.aprobada) creditosAprobados += creditosMateria;
      }

      tablasNiveles += `<tr><td style="text-align:left">${m}</td><td>${creditosMateria}</td><td>${estadoHtml}</td></tr>`;
    });
    tablasNiveles += "</table>";
  }

  document.getElementById("contenido").innerHTML = `
    <h2 class="panel-title">Avance Plan de Estudios — ${e.programa}</h2>
    <div class="aviso">Créditos aprobados: <b>${creditosAprobados}</b> de ${creditosTotalesPrograma} del programa.</div>
    ${tablasNiveles}
  `;
}

function calcularPromedioPonderado(entradas){
  // entradas: [{materia, definitiva, creditos}]
  let sumaProductos = 0, sumaCreditos = 0;
  entradas.forEach(en=>{
    sumaProductos += en.definitiva * en.creditos;
    sumaCreditos += en.creditos;
  });
  if(sumaCreditos===0) return null;
  return { promedio: sumaProductos/sumaCreditos, sumaProductos, sumaCreditos };
}

function tablaPromedio(titulo, entradas){
  if(entradas.length===0){
    return `<h3>${titulo}</h3><p style="font-size:13px;color:#666">Aún no hay materias con actas subidas para este cálculo.</p>`;
  }
  let filas = entradas.map(en=>`
    <tr>
      <td style="text-align:left">${en.materia}</td>
      <td>${en.definitiva.toFixed(1)}</td>
      <td>${en.creditos}</td>
      <td>${(en.definitiva*en.creditos).toFixed(1)}</td>
    </tr>
  `).join("");

  const resultado = calcularPromedioPonderado(entradas);

  return `
    <h3>${titulo}</h3>
    <table>
      <tr><th>Materia</th><th>Definitiva</th><th>Créditos</th><th>Nota × Créditos</th></tr>
      ${filas}
    </table>
    <p style="font-size:13px">
      Suma (Nota × Créditos): <b>${resultado.sumaProductos.toFixed(1)}</b> ÷
      Suma de créditos: <b>${resultado.sumaCreditos}</b> =
    </p>
    <p style="font-size:20px"><b>Promedio: ${resultado.promedio.toFixed(2)}</b></p>
  `;
}

function renderPromedioEstudiante(){
  const e = getEstudiantes()[usuarioActual.codigo];
  const historial = getHistorial()[e.codigo] || {};
  const registro = getMatriculas()[e.codigo];
  const materiasSemestreActual = (registro && registro.materias) ? Object.keys(registro.materias) : [];

  const todasEntradas = Object.keys(historial).map(materia=>({
    materia,
    definitiva: historial[materia].definitiva,
    creditos: historial[materia].creditos
  }));

  const entradasSemestre = todasEntradas.filter(en => materiasSemestreActual.includes(en.materia));

  document.getElementById("contenido").innerHTML = `
    <h2 class="panel-title">Calcular Promedio Final Periodo</h2>
    <p style="font-size:13px;color:#666">
      Promedio Ponderado = Σ(Nota Definitiva × Créditos de la materia) ÷ Σ(Créditos cursados).
      Solo se incluyen materias con actas ya subidas por el docente.
    </p>
    ${tablaPromedio("Promedio Ponderado del Periodo (semestre actual)", entradasSemestre)}
    <hr style="margin:20px 0;border:none;border-top:1px solid #ddd">
    ${tablaPromedio("Promedio Ponderado Acumulado (toda tu carrera)", todasEntradas)}
    ${(()=>{ const s = calcularSituacionAcademica(e.codigo, e.programa);
      const n = s.normalidad || {estado:"Normal"};
      let avisoNormalidad = "";
      if(n.estado==="PFU"){
        avisoNormalidad = `<div class="aviso aviso-error" style="margin-top:15px">🚫 Estás <b>por fuera de la universidad (PFU)</b> por bajo rendimiento académico sostenido.</div>`;
      } else if(n.estado==="Condicional"){
        avisoNormalidad = `<div class="aviso aviso-error" style="margin-top:15px">⚠️ Estás en <b>condición académica CONDICIONAL</b> (semestre ${n.semestresCondicional} de 2 permitidos) — tu promedio acumulado está por debajo de 3.2.</div>`;
      }
      const avisoBono = (s.bono>0)
        ? `<div class="aviso" style="margin-top:15px">🎉 Tu promedio acumulado es superior a 3.6: tienes <b>${s.bono} créditos de bono</b> para adelantar materias del siguiente nivel en tu próxima matrícula.</div>`
        : ``;
      return avisoNormalidad + avisoBono; })()}
  `;
}

/* ======================================================================
   MODAL genérico — ventana emergente centrada para que el estudiante no
   tenga que bajar en la página a ver algo que ya pidió (ej. Notas Parciales).
   ====================================================================== */
function abrirModal(html){
  document.getElementById("modalContenido").innerHTML = html;
  document.getElementById("modalFondo").classList.add("abierto");
}
function cerrarModal(){
  document.getElementById("modalFondo").classList.remove("abierto");
  document.getElementById("modalContenido").innerHTML = "";
}

function renderConsultaMatriculaNotas(){
  const e = getEstudiantes()[usuarioActual.codigo];
  const registro = getMatriculas()[e.codigo];

  if(!registro || registro.estado!=="realizada" || !registro.materias || Object.keys(registro.materias).length===0){
    document.getElementById("contenido").innerHTML=`
      <h2 class="panel-title">Consulta de Matrícula y Notas</h2>
      <p>Aún no tienes materias con horario asignado. Revisa "Matricular Materias".</p>
    `;
    return;
  }

  const gruposPrograma = getGrupos()[e.programa] || {};
  const creditosPrograma = (getProgramas()[e.programa] || {}).creditos || {};

  let entradas = [];
  Object.keys(registro.materias).forEach(materia=>{
    const asign = registro.materias[materia];
    if(asign && typeof asign === "object"){
      entradas.push({materia, componente:"Teorico", grupoId:asign.Teorico});
      entradas.push({materia, componente:"Practico", grupoId:asign.Practico});
    } else {
      entradas.push({materia, componente:null, grupoId:asign});
    }
  });

  let filas = entradas.map((en,i)=>{
    const g = (gruposPrograma[en.materia]||[]).find(x=>x.id===en.grupoId);
    const etiqueta = en.componente ? ` (${en.componente==='Teorico'?'Teórico':'Práctico'})` : "";
    return `<tr>
      <td style="text-align:left">${en.materia}${etiqueta}</td>
      <td>${g ? g.grupo : "-"}</td>
      <td>${creditosPrograma[en.materia]!==undefined ? creditosPrograma[en.materia] : "-"}</td>
      <td><button class="btn-secundario" style="width:auto;padding:6px 14px;font-size:12px" onclick="mostrarNotaMateria(${i})">🔍 Notas Parciales</button></td>
    </tr>`;
  }).join("");

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Consulta de Matrícula y Notas</h2>
    <table>
      <tr><th>Asignatura</th><th>Grupo</th><th>Créditos</th><th>Notas Parciales</th></tr>
      ${filas}
    </table>
  `;

  window.__materiasConsulta = entradas;
}

function mostrarNotaMateria(indice){
  const e = getEstudiantes()[usuarioActual.codigo];
  const en = window.__materiasConsulta[indice];
  const materia = en.materia;
  const grupoId = en.grupoId;
  const gruposPrograma = getGrupos()[e.programa] || {};
  const g = (gruposPrograma[materia]||[]).find(x=>x.id===grupoId);
  const etiquetaComponente = en.componente ? ` (${en.componente==='Teorico'?'Teórico':'Práctico'})` : "";

  const items = getConfigEvaluacion()[grupoId] || [];
  const notasEstudiante = ((getNotas()[grupoId]||{})[e.codigo]) || {};
  const actasSubidas = !!(getActas()[grupoId]);

  let tablaItems;
  if(items.length===0){
    tablaItems = `<p style="font-size:13px;color:#666">El docente aún no ha configurado ítems de evaluación para esta materia.</p>`;
  } else {
    let filasItems = items.map(it=>{
      let valorMostrado;
      if(it.tipo==="asistencia"){
        const v = calcularNotaAsistencia(grupoId, e.codigo);
        valorMostrado = v===null ? "Sin registrar" : `${v.toFixed(1)} <span style="font-size:11px;color:#999">(auto)</span>`;
      } else {
        valorMostrado = (notasEstudiante[it.id]!==undefined && notasEstudiante[it.id]!=="") ? notasEstudiante[it.id] : "Sin registrar";
      }
      return `
      <tr>
        <td style="text-align:left">${it.nombre}</td>
        <td>${it.peso}%</td>
        <td>${valorMostrado}</td>
      </tr>
    `;
    }).join("");

    tablaItems = `
      <table style="max-width:500px">
        <tr><th>Ítem</th><th>%</th><th>Nota</th></tr>
        ${filasItems}
      </table>
    `;
  }

  const definitiva = calcularDefinitivaGrupo(grupoId, e.codigo);
  const estadoTexto = !actasSubidas
    ? `<span style="color:#999">En proceso (aún no son notas oficiales)</span>`
    : (parseFloat(definitiva) >= 3.0
        ? `<span style="color:#1e5631;font-weight:bold">Aprobada ✅</span>`
        : `<span style="color:#a83232;font-weight:bold">Reprobada ❌</span>`);

  abrirModal(`
    <h3 style="margin-top:0">Notas — ${materia}${etiquetaComponente}</h3>
    <p style="font-size:13px;color:#666">Grupo ${g?g.grupo:"-"} · Docente: ${g?g.docente:"-"}</p>
    ${tablaItems}
    <p><b>Definitiva: ${definitiva || "Sin registrar"}</b> — ${estadoTexto}</p>
  `);
}

/* ======================================================================
   ESTUDIANTE — Evaluación Docente
   El estudiante califica de 0 a 50 a cada docente que le dictó materia
   este periodo (matrícula "realizada" actual). Una vez calificada una
   materia con ese docente, queda fija; al abrir un nuevo semestre esa
   calificación se libera de nuevo (igual que las actas/notas).
   ====================================================================== */
function entradasEvaluacionEstudiante(codigo, programaNombre){
  const reg = getMatriculas()[codigo];
  if(!reg || reg.estado!=="realizada" || !reg.materias) return [];
  const gruposPrograma = getGrupos()[programaNombre] || {};
  let entradas = [];
  Object.keys(reg.materias).forEach(materia=>{
    const asign = reg.materias[materia];
    const agregar = (gid, componente)=>{
      const g = (gruposPrograma[materia]||[]).find(x=>x.id===gid);
      if(g) entradas.push({ materia, componente, grupoId:gid, docente:g.docente });
    };
    if(asign && typeof asign==="object"){
      if(asign.Teorico) agregar(asign.Teorico, "Teorico");
      if(asign.Practico) agregar(asign.Practico, "Practico");
    } else if(asign){
      agregar(asign, null);
    }
  });
  return entradas;
}

function renderEvaluacionDocente(){
  const e = getEstudiantes()[usuarioActual.codigo];
  const entradas = entradasEvaluacionEstudiante(e.codigo, e.programa);
  const docentesUnicos = [...new Set(entradas.map(x=>x.docente))];

  const opciones = docentesUnicos.length
    ? docentesUnicos.map(d=>`<option value="${d}">${d}</option>`).join("")
    : `<option value="">(No tienes materias matriculadas este periodo)</option>`;

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Evaluación Docente</h2>
    <p style="font-size:13px;color:#666;max-width:560px">
      Selecciona un docente y califica de 0 a 50 cada materia que te dictó este periodo.
      Una vez guardada, la calificación queda fija.
    </p>
    <div class="form-grid">
      <div class="full"><label>Docente</label><select id="ev_docente" onchange="renderDetalleEvaluacion()">${opciones}</select></div>
    </div>
    <div id="detalleEvaluacion"></div>
  `;
  if(docentesUnicos.length) renderDetalleEvaluacion();
}

function renderDetalleEvaluacion(){
  const e = getEstudiantes()[usuarioActual.codigo];
  const docenteEl = document.getElementById("ev_docente");
  const cont = document.getElementById("detalleEvaluacion");
  if(!docenteEl || !docenteEl.value){ if(cont) cont.innerHTML=""; return; }
  const docente = docenteEl.value;

  const entradas = entradasEvaluacionEstudiante(e.codigo, e.programa).filter(x=>x.docente===docente);
  const evaluaciones = getEvaluacionesDocente();

  const filas = entradas.map((en,i)=>{
    const yaEval = (evaluaciones[en.grupoId]||{})[e.codigo];
    const etiqueta = en.componente ? ` (${en.componente==='Teorico'?'Teórico':'Práctico'})` : "";
    if(yaEval){
      return `<tr><td>${en.materia}${etiqueta}</td><td><b>${yaEval.calificacion}</b> / 50 ✅</td></tr>`;
    }
    return `<tr>
      <td>${en.materia}${etiqueta}</td>
      <td><input type="number" min="0" max="50" id="ev_nota_${i}" style="width:80px"> / 50</td>
    </tr>`;
  }).join("");

  const hayPendientes = entradas.some(en=> !(evaluaciones[en.grupoId]||{})[e.codigo]);

  cont.innerHTML = `
    <div id="avisoEvaluacion"></div>
    <table>
      <tr><th>Materia</th><th>Calificación</th></tr>
      ${filas}
    </table>
    ${hayPendientes
      ? `<button onclick="guardarEvaluacionDocente('${docente.replace(/'/g,"\\'")}')">Guardar Evaluación</button>`
      : `<p style="font-size:13px;color:#1e5631">Ya evaluaste a este docente en todas sus materias este periodo. ¡Gracias!</p>`}
  `;
}

function guardarEvaluacionDocente(docente){
  const e = getEstudiantes()[usuarioActual.codigo];
  const entradas = entradasEvaluacionEstudiante(e.codigo, e.programa).filter(x=>x.docente===docente);
  const evaluaciones = getEvaluacionesDocente();

  let errores = [];
  let pendientes = [];
  entradas.forEach((en,i)=>{
    const yaEval = (evaluaciones[en.grupoId]||{})[e.codigo];
    if(yaEval) return;
    const input = document.getElementById("ev_nota_"+i);
    if(!input || input.value.trim()==="") { errores.push(en.materia); return; }
    const num = parseFloat(input.value);
    if(isNaN(num) || num<0 || num>50){ errores.push(en.materia); return; }
    pendientes.push({en, num});
  });

  if(errores.length){
    document.getElementById("avisoEvaluacion").innerHTML = `<div class="aviso aviso-error">Escribe una calificación entre 0 y 50 para: ${errores.join(", ")}.</div>`;
    return;
  }

  pendientes.forEach(({en,num})=>{
    if(!evaluaciones[en.grupoId]) evaluaciones[en.grupoId] = {};
    evaluaciones[en.grupoId][e.codigo] = { calificacion:num, docente:en.docente, materia:en.materia, componente:en.componente };
  });
  saveEvaluacionesDocente(evaluaciones);

  renderEvaluacionDocente();
}

/* Grilla de horario "bonita" para el estudiante: colores por materia, y muestra
   materia + grupo + salón + docente en cada celda. La franja de 12-14 (almuerzo)
   se pinta siempre como una franja roja no programable, fusionando las dos horas
   en una sola fila, igual que en las plantillas de horario típicas de la universidad. */
function construirGrillaHorarioEstudiante(entradas){
  const bloques = ["6-7","7-8","8-9","9-10","10-11","11-12","12-13","13-14",
                    "14-15","15-16","16-17","17-18","18-19","19-20","20-21","21-22"];
  const dias = ["Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
  const paletaColores = ["#ffe08a","#a8d8b9","#a9d4f5","#f5b8a3","#c9b8f5","#f5a3c9","#b8e0f5","#d4f5a3","#f5d0a3","#c2c2f0"];
  const colorPorMateria = {};
  let siguienteColor = 0;
  function colorDe(materia){
    if(!colorPorMateria[materia]){
      colorPorMateria[materia] = paletaColores[siguienteColor % paletaColores.length];
      siguienteColor++;
    }
    return colorPorMateria[materia];
  }

  function bloqueDeHora(horaStr){
    if(!horaStr) return null;
    const h = parseInt(horaStr.split(":")[0], 10);
    const idx = h - 6;
    return (idx >= 0 && idx < bloques.length) ? idx : null;
  }

  let grid = {};
  entradas.forEach(en => {
    const idxIni = bloqueDeHora(en.horaInicio);
    if(idxIni === null) return;
    // Si la clase dura varias horas (ej. 8-10), se dibuja en cada franja que ocupa
    // (8-9 y 9-10), no solo en la franja de inicio.
    let idxFin = bloqueDeHora(en.horaFin);
    if(idxFin === null || idxFin <= idxIni) idxFin = idxIni + 1;
    for(let idx = idxIni; idx < idxFin; idx++){
      if(idx >= bloques.length) break;
      if(!grid[idx]) grid[idx] = {};
      if(!grid[idx][en.dia]) grid[idx][en.dia] = [];
      grid[idx][en.dia].push(en);
    }
  });

  let html = `<table class="horario-estudiante">
    <tr>
      <th>HORA</th>
      ${dias.map(d=>`<th>${d.toUpperCase()}</th>`).join("")}
    </tr>`;

  bloques.forEach((b, idx) => {
    if(b === "13-14") return; // ya se dibuja fusionada con 12-13
    if(b === "12-13"){
      html += `<tr>
        <td class="celda-hora">12-14</td>
        <td colspan="${dias.length}" class="fila-almuerzo">ALMUERZO — no se programan clases en este horario</td>
      </tr>`;
      return;
    }
    html += `<tr><td class="celda-hora">${b}</td>`;
    dias.forEach(d => {
      const celdas = (grid[idx] && grid[idx][d]) ? grid[idx][d] : [];
      html += `<td>
        ${celdas.map(en => `
          <div class="materia-bloque" style="background:${colorDe(en.materia)}">
            <b>${en.materia}</b>
            Grupo: ${en.grupo}<br>
            Salón: ${en.salon || "-"}<br>
            Docente: ${en.docente || "-"}
          </div>
        `).join("")}
      </td>`;
    });
    html += "</tr>";
  });
  html += "</table>";
  return html;
}

function renderHorarioEstudiante(){
  const e = getEstudiantes()[usuarioActual.codigo];
  const registro = getMatriculas()[e.codigo];
  const gruposPrograma = getGrupos()[e.programa] || {};

  let entradas=[];
  if(registro && registro.materias){
    Object.keys(registro.materias).forEach(materia=>{
      const asign = registro.materias[materia];
      const listaGrupos = gruposPrograma[materia] || [];
      const ids = (asign && typeof asign==="object") ? [asign.Teorico, asign.Practico] : [asign];
      ids.forEach(grupoId=>{
        const g = listaGrupos.find(x=>x.id===grupoId);
        if(g){
          const etiqueta = g.componente ? ` (${g.componente==='Teorico'?'Teórico':'Práctico'})` : "";
          (g.bloques||[]).forEach(b=>{
            entradas.push({materia: materia+etiqueta, grupo:g.grupo, dia:b.dia, horaInicio:b.horaInicio, horaFin:b.horaFin, salon:b.salon, docente:g.docente});
          });
        }
      });
    });
  }

  const grid = construirGrillaHorarioEstudiante(entradas);
  const mensaje = entradas.length
    ? ""
    : `<p style="font-size:13px;color:#666">Aún no tienes horario generado. Ve a <b>Servicios Académicos → Matricular Materias</b>.</p>`;

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Horario Actual — ${e.programa}</h2>
    ${mensaje}
    <div class="horario-scroll">${grid}</div>
  `;
}

function obtenerNivelIndice(codigo, programaNombre, nivelesKeys){
  const niveles = getNivelesEstudiantes();
  const historial = getHistorial()[codigo] || {};
  const data = getProgramas()[programaNombre] || {niveles:{}};

  // Una materia está aprobada si aparece en el historial
  // y su definitiva está marcada como aprobada.
  const estaAprobada = materia =>
    !!(historial[materia] && historial[materia].aprobada);

  // El nivel actual siempre es el PRIMER nivel que tenga
  // al menos una materia pendiente.
  //
  // Si Nivel 1 está completamente aprobado,
  // el estudiante pasa automáticamente a Nivel 2.
  let idxActual = nivelesKeys.length - 1;

  for(let i = 0; i < nivelesKeys.length; i++){
    const materias = data.niveles[nivelesKeys[i]] || [];

    const tienePendientes = materias.some(m => !estaAprobada(m));

    if(tienePendientes){
      idxActual = i;
      break;
    }
  }

  // Guardamos el nivel actualizado para que quede sincronizado.
  if(niveles[codigo] !== idxActual){
    niveles[codigo] = idxActual;
    saveNivelesEstudiantes(niveles);
  }

  return idxActual;
}
function calcularSituacionAcademica(codigo, programaNombre){
  const data = getProgramas()[programaNombre] || {niveles:{}, creditos:{}};
  const nivelesKeys = Object.keys(data.niveles || {});
  const creditosProg = data.creditos || {};
  const electivasProg = data.electivas || {}; // { slotName: [{nombre, prerequisitos}] }
  const prerequisitosProg = data.prerequisitos || {};
  const historial = getHistorial()[codigo] || {};

  // Mapa curso-de-catálogo -> cupo del pensum al que pertenece (para heredar créditos).
  let cursoASlot = {};
  Object.keys(electivasProg).forEach(slot=>{
    const lista = electivasProg[slot];
    if(!Array.isArray(lista)) return; // formato viejo (nombre->créditos): se ignora
    lista.forEach(op=>{ if(op && op.nombre) cursoASlot[op.nombre] = slot; });
  });

  function estaAprobada(materia){
    return !!(historial[materia] && historial[materia].aprobada);
  }
  function creditosDe(m){
    if(creditosProg[m]!==undefined) return creditosProg[m];
    if(cursoASlot[m] && creditosProg[cursoASlot[m]]!==undefined) return creditosProg[cursoASlot[m]];
    return 3;
  }
  function prerequisitosDe(m){ return prerequisitosProg[m] || []; }
  function prerequisitosCumplidos(m){ return prerequisitosDe(m).every(p=>estaAprobada(p)); }
  function prerequisitosFaltantes(m){ return prerequisitosDe(m).filter(p=>!estaAprobada(p)); }

  if(nivelesKeys.length===0){
    return { sinPensum:true, graduado:false };
  }

  const normalidad = getNormalidadEstudiantes()[codigo] || { estado:"Normal", semestresCondicional:0 };
  if(normalidad.estado === "PFU"){
    return { expulsado:true, normalidad, graduado:false };
  }

  // Graduado = de verdad aprobó TODAS las materias de TODOS los niveles (incluye los cupos de electiva).
  const graduado = nivelesKeys.every(nk => (data.niveles[nk]||[]).every(m=>estaAprobada(m)));

  const nivelIndex = obtenerNivelIndice(codigo, programaNombre, nivelesKeys);
  const nivelActualKey = nivelesKeys[nivelIndex];

  // Materias de niveles anteriores que sigue debiendo: repetición obligatoria,
  // sin importar que ya haya "avanzado" de nivel.
  let pendientesAtrasadas = [];
  for(let i=0;i<nivelIndex;i++){
    (data.niveles[nivelesKeys[i]]||[]).forEach(m=>{ if(!estaAprobada(m)) pendientesAtrasadas.push(m); });
  }
  // Solo las que ya tienen su requisito cumplido se pueden matricular de verdad
  // (y por lo tanto solo esas consumen crédito del nivel nuevo).
  const pendientesAtrasadasDisponibles = pendientesAtrasadas.filter(m=>prerequisitosCumplidos(m));

  // Materias del nivel al que avanzó, que aún no tiene aprobadas.
  const materiasNivelActual = (data.niveles[nivelActualKey]||[]).filter(m=>!estaAprobada(m));
  const materiasNivelActualDisponibles = materiasNivelActual.filter(m=>prerequisitosCumplidos(m));

  // El presupuesto de créditos es el del nivel al que avanza (no crece por atrasos).
  // Si el estudiante está en condición Condicional, la normatividad le limita a 12 créditos sí o sí.
  let creditosBase = (data.niveles[nivelActualKey]||[]).reduce((s,m)=>s+creditosDe(m),0);
  if(normalidad.estado === "Condicional"){
    creditosBase = Math.min(creditosBase, 12);
  }
  const creditosBacklog = pendientesAtrasadasDisponibles.reduce((s,m)=>s+creditosDe(m),0);

  const todasEntradas = Object.keys(historial).map(m=>({
    materia:m, definitiva:historial[m].definitiva, creditos:historial[m].creditos
  }));
  const rp = todasEntradas.length>0 ? calcularPromedioPonderado(todasEntradas) : null;
  const promedioAcumulado = rp ? rp.promedio : null;
  const bono = (promedioAcumulado!==null && promedioAcumulado>3.6) ? 4 : 0;

  const creditosDisponibles = creditosBase + bono;
  // Lo atrasado se descuenta primero; lo que sobra es lo que puede elegir.
  const creditosRestantesParaElegir = Math.max(0, creditosDisponibles - creditosBacklog);

  const nivelSiguienteKey = nivelesKeys[nivelIndex+1];
  const materiasNivelSiguiente = (bono>0 && nivelSiguienteKey)
    ? (data.niveles[nivelSiguienteKey]||[]).filter(m=>!estaAprobada(m))
    : [];
  const materiasNivelSiguienteDisponibles = materiasNivelSiguiente.filter(m=>prerequisitosCumplidos(m));

  return {
    graduado, nivelActual: nivelActualKey, nivelIndex, normalidad,
    pendientesAtrasadas, pendientesAtrasadasDisponibles,
    materiasNivelActual, materiasNivelActualDisponibles,
    materiasNivelSiguiente, materiasNivelSiguienteDisponibles,
    creditosDe, prerequisitosDe, prerequisitosCumplidos, prerequisitosFaltantes,
    creditosBase, creditosBacklog, bono, creditosDisponibles,
    creditosRestantesParaElegir, promedioAcumulado
  };
}

function materiaTieneGruposCompletos(programaNombre, gruposPrograma, materia){
  const lista = gruposPrograma[materia] || [];
  if(esMateriaTP(programaNombre, materia)){
    return lista.some(g=>g.componente==="Teorico") && lista.some(g=>g.componente==="Practico");
  }
  return lista.length>0;
}

function materiasOpcionalesDeMatricula(situacion){
  return [...situacion.materiasNivelActualDisponibles, ...situacion.materiasNivelSiguienteDisponibles];
}


function renderMatricularMaterias(){
  const e = getEstudiantes()[usuarioActual.codigo];
  const registro = getMatriculas()[e.codigo];
  const abiertas = !!(getEstadoMatriculas()[e.programa]);

  /* Caso 0: quedó con evaluación docente obligatoria pendiente del semestre anterior */
  if(!registro){
    const pend = getEvaluacionPendiente()[e.codigo];
    if(pend && pend.pendiente){
      document.getElementById("contenido").innerHTML=`
        <h2 class="panel-title">Matrícula — ${e.programa}</h2>
        <div class="aviso aviso-error">
          🔒 No puedes solicitar matrícula todavía: quedaste con <b>evaluación docente pendiente y obligatoria</b>
          del semestre anterior${pend.detalle && pend.detalle.length ? ` (${pend.detalle.join(", ")})` : ""}.
          Esa evaluación ya no está disponible porque el semestre cerró; contacta a
          <b>Coordinación Académica</b> para que te habilite la matrícula.
        </div>
      `;
      return;
    }
  }

  /* Caso 1: el horario ya fue generado por el Coordinador */
  if(registro && registro.estado === "realizada"){
    const materiasMatriculadas = Object.keys(registro.materias || {});
    const gruposPrograma = getGrupos()[e.programa] || {};

    let filas = "";
    materiasMatriculadas.forEach(materia=>{
      const asign = registro.materias[materia];
      if(asign && typeof asign === "object"){
        const gT = (gruposPrograma[materia]||[]).find(x=>x.id===asign.Teorico);
        const gP = (gruposPrograma[materia]||[]).find(x=>x.id===asign.Practico);
        filas += `<tr>
          <td>${materia} (Teórico)</td>
          <td>${gT ? gT.grupo : "-"}</td>
          <td>${gT ? gT.docente : "-"}</td>
          <td style="text-align:left">${gT ? resumenBloques(gT.bloques) : "-"}</td>
        </tr>`;
        filas += `<tr>
          <td>${materia} (Práctico)</td>
          <td>${gP ? gP.grupo : "-"}</td>
          <td>${gP ? gP.docente : "-"}</td>
          <td style="text-align:left">${gP ? resumenBloques(gP.bloques) : "-"}</td>
        </tr>`;
      } else {
        const g = (gruposPrograma[materia]||[]).find(x=>x.id===asign);
        filas += `<tr>
          <td>${materia}</td>
          <td>${g ? g.grupo : "-"}</td>
          <td>${g ? g.docente : "-"}</td>
          <td style="text-align:left">${g ? resumenBloques(g.bloques) : "-"}</td>
        </tr>`;
      }
    });

    let avisoSinCupo = "";
    if(registro.materiasSinCupo && registro.materiasSinCupo.length){
      avisoSinCupo = `<div class="aviso aviso-error">Estas materias no tenían cupo disponible cuando se generó el horario: ${registro.materiasSinCupo.join(", ")}. Habla con el Coordinador Académico.</div>`;
    }

    if(!filas) filas = `<tr><td colspan="4">No te quedó ninguna materia asignada.</td></tr>`;

    document.getElementById("contenido").innerHTML=`
      <h2 class="panel-title">Matrícula — ${e.programa}</h2>
      <div class="aviso">Tu horario ya fue generado por el Coordinador Académico. La matrícula solo se hace una vez.</div>
      ${avisoSinCupo}
      <table>
        <tr><th>Materia</th><th>Grupo asignado</th><th>Docente</th><th>Horario</th></tr>
        ${filas}
      </table>
    `;
    return;
  }

  /* Caso 2: ya envió su solicitud, pero el Coordinador aún no genera horarios */
  if(registro && registro.estado === "solicitada"){
    document.getElementById("contenido").innerHTML=`
      <h2 class="panel-title">Matrícula — ${e.programa}</h2>
      <div class="aviso">
        Ya enviaste tu solicitud de matrícula. Está <b>pendiente</b> de que el Coordinador Académico cierre
        matrículas y genere los horarios. Cuando eso pase, aquí mismo verás tu grupo asignado.
      </div>
      <p><b>Materias solicitadas:</b></p>
      <ul>${(registro.materiasSolicitadas||[]).map(m=>`<li>${m}</li>`).join("")}</ul>
    `;
    return;
  }

  /* Caso 3: las matrículas están cerradas y el estudiante nunca solicitó nada */
  if(!abiertas){
    document.getElementById("contenido").innerHTML=`
      <h2 class="panel-title">Matrícula — ${e.programa}</h2>
      <div class="aviso aviso-error">
        Las matrículas de ${e.programa} están cerradas y no enviaste ninguna solicitud.
        Esto significa que no cursarás materias este semestre. Si crees que es un error,
        contacta al Coordinador Académico de tu programa.
      </div>
    `;
    return;
  }

  /* Caso 4: matrículas abiertas y el estudiante aún no ha solicitado nada */
  const dataPrograma = getProgramas()[e.programa];
  const gruposPrograma = getGrupos()[e.programa] || {};

  if(!dataPrograma || !dataPrograma.niveles || Object.keys(dataPrograma.niveles).length===0){
    document.getElementById("contenido").innerHTML=`<h2 class="panel-title">Matricular Materias</h2><p>El Director de Escuela aún no ha publicado el plan de estudios de ${e.programa}.</p>`;
    return;
  }

  const situacion = calcularSituacionAcademica(e.codigo, e.programa);

  if(situacion.expulsado){
    document.getElementById("contenido").innerHTML=`
      <h2 class="panel-title">Matricular Materias — ${e.programa}</h2>
      <div class="aviso aviso-error">
        🚫 Estás <b>por fuera de la universidad (PFU)</b> por bajo rendimiento académico sostenido:
        tu promedio acumulado estuvo por debajo de 3.2 durante 3 semestres consecutivos.
        No puedes matricular materias. Comunícate con la Coordinación Académica.
      </div>
    `;
    return;
  }

  if(situacion.graduado){
    document.getElementById("contenido").innerHTML=`
      <h2 class="panel-title">Matricular Materias — ${e.programa}</h2>
      <div class="aviso">🎓 Ya aprobaste todas las materias del plan de estudios. No tienes materias pendientes por matricular.</div>
    `;
    return;
  }

  const historialEstudiante = getHistorial()[e.codigo] || {};

  const filasAtrasadas = situacion.pendientesAtrasadas.map(materia=>{
    const cred = situacion.creditosDe(materia);
    if(!situacion.prerequisitosCumplidos(materia)){
      return `<tr><td>${materia}</td><td>${cred}</td><td style="color:#a83232">Requisito no cumplido: ${situacion.prerequisitosFaltantes(materia).join(", ")}</td></tr>`;
    }
    if(esMateriaElectivaSlot(e.programa, materia)){
      const idxAtr = situacion.pendientesAtrasadasDisponibles.indexOf(materia);
      const opciones = opcionesDeSlotDisponibles(e.programa, materia, historialEstudiante)
        .filter(op=>materiaTieneGruposCompletos(e.programa, gruposPrograma, op.nombre));
      if(opciones.length===0){
        return `<tr><td>${materia}</td><td>${cred}</td><td style="color:#999">Sin cursos de catálogo disponibles todavía (pídele al Coordinador que programe grupos)</td></tr>`;
      }
      const opts = opciones.map(op=>`<option value="${op.nombre}">${op.nombre}</option>`).join("");
      return `<tr><td>${materia} <span style="font-size:11px;color:#666">(electiva)</span></td><td>${cred}</td><td>Elige el curso: <select id="mm_atr_${idxAtr}">${opts}</select></td></tr>`;
    }
    if(!materiaTieneGruposCompletos(e.programa, gruposPrograma, materia)){
      return `<tr><td>${materia}</td><td>${cred}</td><td style="color:#999">Sin grupos programados todavía${esMateriaTP(e.programa,materia)?" (falta Teórico y/o Práctico)":""}</td></tr>`;
    }
    return `<tr><td>${materia}</td><td>${cred}</td><td style="color:#a83232">Repetición obligatoria (perdida antes)</td></tr>`;
  }).join("") || `<tr><td colspan="3" style="color:#999">No tienes materias atrasadas 🎉</td></tr>`;

  const opcionalesTodas = [
    ...situacion.materiasNivelActual.map(m=>({materia:m, tipo:"nivel"})),
    ...(situacion.bono>0 ? situacion.materiasNivelSiguiente.map(m=>({materia:m, tipo:"adelantada"})) : [])
  ];
  const opcionalesDisponibles = materiasOpcionalesDeMatricula(situacion);

  const filasOpcionales = opcionalesTodas.map(op=>{
    const materia = op.materia;
    const cred = situacion.creditosDe(materia);
    const etiqueta = op.tipo==="adelantada" ? "Adelantada (bono)" : `Nivel actual (${situacion.nivelActual})`;
    if(!situacion.prerequisitosCumplidos(materia)){
      return `<tr><td>${materia}</td><td>${cred}</td><td style="color:#a83232">Requisito no cumplido: ${situacion.prerequisitosFaltantes(materia).join(", ")}</td><td>${etiqueta}</td></tr>`;
    }
    const i = opcionalesDisponibles.indexOf(materia);
    if(esMateriaElectivaSlot(e.programa, materia)){
      const opciones = opcionesDeSlotDisponibles(e.programa, materia, historialEstudiante)
        .filter(op2=>materiaTieneGruposCompletos(e.programa, gruposPrograma, op2.nombre));
      if(opciones.length===0){
        return `<tr><td>${materia} <span style="font-size:11px;color:#666">(electiva)</span></td><td>${cred}</td><td style="color:#999">Sin cursos de catálogo disponibles</td><td>${etiqueta}</td></tr>`;
      }
      const opts = `<option value="">-- No matricular --</option>` + opciones.map(o=>`<option value="${o.nombre}">${o.nombre}</option>`).join("");
      return `<tr>
        <td>${materia} <span style="font-size:11px;color:#666">(electiva)</span></td><td>${cred}</td>
        <td><select id="mm_op_${i}" data-creditos="${cred}" onchange="actualizarContadorMatricula(${situacion.creditosRestantesParaElegir})">${opts}</select></td>
        <td style="font-size:12px">${etiqueta}</td>
      </tr>`;
    }
    if(!materiaTieneGruposCompletos(e.programa, gruposPrograma, materia)){
      return `<tr><td>${materia}</td><td>${cred}</td><td style="color:#999">Sin grupos programados${esMateriaTP(e.programa,materia)?" (falta Teórico y/o Práctico)":""}</td><td>${etiqueta}</td></tr>`;
    }
    return `<tr>
      <td>${materia}</td><td>${cred}</td>
      <td><input type="checkbox" id="mm_op_${i}" data-creditos="${cred}" onchange="actualizarContadorMatricula(${situacion.creditosRestantesParaElegir})"></td>
      <td style="font-size:12px">${etiqueta}</td>
    </tr>`;
  }).join("");

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Matricular Materias — ${e.programa}</h2>
    <div id="avisoMatriculaEstudiante"></div>
    ${situacion.normalidad.estado==="Condicional" ? `
      <div class="aviso aviso-error">
        ⚠️ Estás en <b>condición académica CONDICIONAL</b> (semestre ${situacion.normalidad.semestresCondicional} de 2 permitidos)
        — tu promedio acumulado sigue por debajo de 3.2. Por normatividad, este semestre solo tienes derecho a
        <b>máximo 12 créditos</b>. Si tu promedio acumulado sigue por debajo de 3.2 al terminar este semestre,
        quedarás <b>por fuera de la universidad (PFU)</b>.
      </div>
    ` : ``}
    <div class="aviso">
      Las matrículas están abiertas. Solo puedes enviar tu solicitud <b>una vez</b>.<br>
      Avanzas a <b>${situacion.nivelActual}</b>. Créditos de este nivel: <b>${situacion.creditosBase}</b>
      ${situacion.bono>0 ? ` + <b>${situacion.bono}</b> de bono` : ``}
      ${situacion.creditosBacklog>0 ? ` − <b>${situacion.creditosBacklog}</b> usados por materias atrasadas` : ``}
      = <b>${situacion.creditosRestantesParaElegir}</b> créditos disponibles para elegir abajo.
      ${situacion.creditosBacklog>0 ? `<br><span style="color:#a83232">Como tienes materias atrasadas, es posible que no te alcancen los créditos para ver todas las materias de tu nivel: elige cuáles ver.</span>` : ``}
    </div>

    <h3>Materias atrasadas (obligatorias, se matriculan solas)</h3>
    <table>
      <tr><th>Materia</th><th>Créditos</th><th>Estado</th></tr>
      ${filasAtrasadas}
    </table>

    <h3 style="margin-top:20px">Elige tus materias — créditos disponibles: <span id="creditosRestantesLabel" style="color:#1e5631">${situacion.creditosRestantesParaElegir}</span></h3>
    <table>
      <tr><th>Materia</th><th>Créditos</th><th>Solicitar</th><th>Tipo</th></tr>
      ${filasOpcionales || `<tr><td colspan="4" style="color:#999">No hay materias disponibles todavía.</td></tr>`}
    </table>

    <button onclick="guardarMatriculaEstudiante()">Enviar Solicitud de Matrícula (definitiva)</button>
  `;
}

function actualizarContadorMatricula(limite){
  let usados = 0;
  document.querySelectorAll('input[id^="mm_op_"]').forEach(chk=>{
    if(chk.checked) usados += parseInt(chk.getAttribute("data-creditos"),10) || 0;
  });
  document.querySelectorAll('select[id^="mm_op_"]').forEach(sel=>{
    if(sel.value) usados += parseInt(sel.getAttribute("data-creditos"),10) || 0;
  });
  const restante = limite - usados;
  const label = document.getElementById("creditosRestantesLabel");
  if(label){
    label.textContent = restante;
    label.style.color = restante < 0 ? "#a83232" : "#1e5631";
  }
}

function guardarMatriculaEstudiante(){
  const e = getEstudiantes()[usuarioActual.codigo];

  const pend = getEvaluacionPendiente()[e.codigo];
  if(pend && pend.pendiente){
    renderMatricularMaterias();
    return;
  }

  const gruposPrograma = getGrupos()[e.programa] || {};
  const situacion = calcularSituacionAcademica(e.codigo, e.programa);

  if(situacion.expulsado || situacion.graduado){
    renderMatricularMaterias();
    return;
  }

  let materiasSolicitadas = [];
  let electivaSlotDe = {}; // curso elegido del catálogo -> nombre del cupo del pensum que llena
  let atrasadasSinElegir = [];

  situacion.pendientesAtrasadasDisponibles.forEach((materia, idxAtr)=>{
    if(esMateriaElectivaSlot(e.programa, materia)){
      const sel = document.getElementById("mm_atr_"+idxAtr);
      if(sel && sel.value){
        materiasSolicitadas.push(sel.value);
        electivaSlotDe[sel.value] = materia;
      } else {
        atrasadasSinElegir.push(materia);
      }
    } else if(materiaTieneGruposCompletos(e.programa, gruposPrograma, materia)){
      materiasSolicitadas.push(materia);
    }
  });

  if(atrasadasSinElegir.length){
    document.getElementById("avisoMatriculaEstudiante").innerHTML = `<div class="aviso aviso-error">Elige un curso del catálogo para tu electiva atrasada: ${atrasadasSinElegir.join(", ")}.</div>`;
    return;
  }

  const opcionales = materiasOpcionalesDeMatricula(situacion);
  let creditosSeleccionados = 0;
  opcionales.forEach((materia,i)=>{
    if(esMateriaElectivaSlot(e.programa, materia)){
      const sel = document.getElementById("mm_op_"+i);
      if(sel && sel.value){
        materiasSolicitadas.push(sel.value);
        electivaSlotDe[sel.value] = materia;
        creditosSeleccionados += situacion.creditosDe(materia);
      }
    } else {
      const chk = document.getElementById("mm_op_"+i);
      if(chk && chk.checked){
        materiasSolicitadas.push(materia);
        creditosSeleccionados += situacion.creditosDe(materia);
      }
    }
  });

  if(creditosSeleccionados > situacion.creditosRestantesParaElegir){
    document.getElementById("avisoMatriculaEstudiante").innerHTML = `<div class="aviso aviso-error">Seleccionaste ${creditosSeleccionados} créditos, pero solo tienes ${situacion.creditosRestantesParaElegir} disponibles. Desmarca alguna materia.</div>`;
    return;
  }

  if(materiasSolicitadas.length===0){
    document.getElementById("avisoMatriculaEstudiante").innerHTML = `<div class="aviso aviso-error">No hay materias disponibles para matricular todavía (verifica que el Coordinador haya programado grupos).</div>`;
    return;
  }

  pedirConfirmacion("Tu solicitud solo se puede enviar una vez. ¿Confirmas que ya elegiste todas las materias que quieres cursar?", function(){
    const matriculas = getMatriculas();
    matriculas[usuarioActual.codigo] = { estado:"solicitada", materiasSolicitadas, electivaSlotDe };
    saveMatriculas(matriculas);
    renderMatricularMaterias();
  });
}

/* ======================================================================
   MÓDULO DOCENTE
   ====================================================================== */
function renderHorarioDocente(){
  const programas = programasDelDocente();
  const todosLosGrupos = getGrupos();

  let entradas=[];
  programas.forEach(prog=>{
    const grupos = todosLosGrupos[prog] || {};
    Object.keys(grupos).forEach(materia=>{
      grupos[materia].forEach(g=>{
        if(g.docente === usuarioActual.nombre){
          const etiquetaPrograma = programas.length>1 ? ` [${prog}]` : "";
          (g.bloques||[]).forEach(b=>{
            entradas.push({materia: materia+etiquetaPrograma, grupo:g.grupo, dia:b.dia, horaInicio:b.horaInicio, horaFin:b.horaFin, salon:b.salon});
          });
        }
      });
    });
  });

  const grid = construirGrillaHorario(entradas);
  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Horario Actual — ${usuarioActual.nombre}</h2>
    <p style="font-size:13px;color:#666">Programa(s): ${programas.join(", ")}</p>
    ${grid}
  `;
}

/* Promedio de evaluación docente recibida, SIEMPRE anónimo: nunca se expone qué
   estudiante puso cada nota, solo el conteo y el promedio por materia/grupo. */
function renderEvaluacionRecibidaDocente(){
  const programas = programasDelDocente();
  const todosLosGrupos = getGrupos();
  const evaluaciones = getEvaluacionesDocente();

  let filas = [];
  let sumaTotal = 0, cantidadTotal = 0;

  programas.forEach(prog=>{
    const grupos = todosLosGrupos[prog] || {};
    Object.keys(grupos).forEach(materia=>{
      (grupos[materia]||[]).forEach(g=>{
        if(g.docente !== usuarioActual.nombre) return;
        const evalsGrupo = evaluaciones[g.id] || {};
        const notas = Object.values(evalsGrupo).map(x=>x.calificacion);
        if(notas.length===0) return;
        const promedio = notas.reduce((a,b)=>a+b,0) / notas.length;
        sumaTotal += notas.reduce((a,b)=>a+b,0);
        cantidadTotal += notas.length;
        const etiquetaPrograma = programas.length>1 ? ` [${prog}]` : "";
        filas.push(`
          <tr>
            <td>${materia}${etiquetaPrograma}${g.componente ? " ("+(g.componente==='Teorico'?'Teórico':'Práctico')+")" : ""}</td>
            <td>${g.grupo}</td>
            <td>${notas.length}</td>
            <td><b>${promedio.toFixed(1)}</b> / 50</td>
          </tr>
        `);
      });
    });
  });

  const promedioGeneral = cantidadTotal ? (sumaTotal/cantidadTotal).toFixed(1) : null;

  document.getElementById("contenido").innerHTML = `
    <h2 class="panel-title">Evaluación Docente Recibida</h2>
    <p style="font-size:13px;color:#666;max-width:560px">
      Promedio de las calificaciones (0-50) que te dieron tus estudiantes este periodo, por materia y grupo.
      La evaluación es <b>anónima</b>: nunca se muestra qué estudiante puso cada nota, solo el promedio.
    </p>
    ${promedioGeneral ? `<div class="aviso">Promedio general recibido: <b>${promedioGeneral}</b> / 50 (${cantidadTotal} evaluación(es))</div>` : ""}
    ${filas.length ? `
      <table>
        <tr><th>Materia</th><th>Grupo</th><th># Evaluaciones</th><th>Promedio</th></tr>
        ${filas.join("")}
      </table>
    ` : `<p style="font-size:13px;color:#666">Todavía no tienes evaluaciones registradas este periodo.</p>`}
  `;
}

function estudiantesDeGrupo(programa, materia, grupoId){
  const estudiantes = getEstudiantes();
  const matriculas = getMatriculas();
  return Object.values(estudiantes).filter(e=>{
    if(e.programa!==programa) return false;
    const reg = matriculas[e.codigo];
    if(!reg || !reg.materias) return false;
    const val = reg.materias[materia];
    if(val && typeof val==="object"){
      return val.Teorico===grupoId || val.Practico===grupoId;
    }
    return val===grupoId;
  });
}

/* Definitiva de la materia = promedio ponderado de los ítems de evaluación configurados */
function calcularDefinitivaGrupo(grupoId, codigo){
  const items = getConfigEvaluacion()[grupoId] || [];
  const notasEstudiante = ((getNotas()[grupoId] || {})[codigo]) || {};

  if(items.length===0) return "";

  let sumaPeso=0, sumaPonderada=0;
  items.forEach(item=>{
    let valor;
    if(item.tipo==="asistencia"){
      const v = calcularNotaAsistencia(grupoId, codigo);
      valor = (v===null) ? NaN : v;
    } else {
      valor = parseFloat(notasEstudiante[item.id]);
    }
    const peso = parseFloat(item.peso) || 0;
    if(!isNaN(valor)){
      sumaPonderada += valor*peso;
      sumaPeso += peso;
    }
  });

  if(sumaPeso===0) return "";
  return (sumaPonderada/sumaPeso).toFixed(1);
}

function agregarItemEvaluacion(grupoId){
  const nombre = document.getElementById("item_nombre_"+grupoId).value.trim();
  const peso = parseFloat(document.getElementById("item_peso_"+grupoId).value);
  const checkAsistencia = document.getElementById("item_asistencia_"+grupoId);
  const esAsistencia = !!(checkAsistencia && checkAsistencia.checked);
  if(!nombre || !peso || peso<=0){
    document.getElementById("avisoItems_"+grupoId).innerHTML = `<div class="aviso aviso-error">Escribe un nombre y un porcentaje válido (mayor a 0).</div>`;
    return;
  }
  const config = getConfigEvaluacion();
  if(!config[grupoId]) config[grupoId] = [];
  if(esAsistencia && config[grupoId].some(it=>it.tipo==="asistencia")){
    document.getElementById("avisoItems_"+grupoId).innerHTML = `<div class="aviso aviso-error">Ya existe un ítem de asistencia en este grupo.</div>`;
    return;
  }
  config[grupoId].push({ id: siguienteIdItemEvaluacion(), nombre, peso, tipo: esAsistencia ? "asistencia" : "manual" });
  saveConfigEvaluacion(config);
  renderNotasDocente();
}

function eliminarItemEvaluacion(grupoId, itemId){
  const config = getConfigEvaluacion();
  config[grupoId] = (config[grupoId]||[]).filter(it=>it.id!==itemId);
  saveConfigEvaluacion(config);
  renderNotasDocente();
}

/* Intenta publicar en el historial la nota definitiva de una materia para un estudiante.
   Si la materia es simple, publica en cuanto ese grupo tenga actas.
   Si es Teórico/Práctico, solo publica cuando AMBOS componentes de ESE estudiante
   ya tengan actas subidas, combinando las notas con el % que definió el Director. */
function intentarPublicarHistorial(programaNombre, materia, codigo){
  const dataPrograma = getProgramas()[programaNombre] || {};
  const tipoInfo = (dataPrograma.tipos||{})[materia];
  const creditosPrograma = dataPrograma.creditos || {};

  const matriculas = getMatriculas();
  const reg = matriculas[codigo];
  if(!reg || !reg.materias || reg.materias[materia]===undefined) return;
  const asign = reg.materias[materia];

  // Si "materia" es en realidad un curso de catálogo elegido para llenar un cupo de
  // electiva del pensum, los créditos y el requisito de nivel son los del cupo, no los del curso.
  const slotDeElectiva = (reg.electivaSlotDe||{})[materia];
  const creditosMateria = creditosPrograma[materia] !== undefined
    ? creditosPrograma[materia]
    : (slotDeElectiva && creditosPrograma[slotDeElectiva]!==undefined ? creditosPrograma[slotDeElectiva] : 3);

  const actas = getActas();
  const gruposPrograma = getGrupos()[programaNombre] || {};

  let definitivaFinal, grupoLabel, docenteLabel, aprobadaFinal;

  if(tipoInfo && tipoInfo.tp){
    const gidT = asign.Teorico, gidP = asign.Practico;
    if(!actas[gidT] || !actas[gidP]) return; // aún falta un componente por subir
    const notaT = parseFloat(calcularDefinitivaGrupo(gidT, codigo));
    const notaP = parseFloat(calcularDefinitivaGrupo(gidP, codigo));
    if(isNaN(notaT) || isNaN(notaP)) return;
    const pctT = (tipoInfo.pctTeorico!==undefined ? tipoInfo.pctTeorico : 70) / 100;
    definitivaFinal = notaT*pctT + notaP*(1-pctT);
    // No basta con que la ponderada dé arriba de 3.0: cada componente (Teórico Y Práctico)
    // debe estar aprobado por separado para que la materia cuente como aprobada.
    aprobadaFinal = (definitivaFinal >= 3.0) && (notaT >= 3.0) && (notaP >= 3.0);
    const gT = (gruposPrograma[materia]||[]).find(x=>x.id===gidT);
    const gP = (gruposPrograma[materia]||[]).find(x=>x.id===gidP);
    grupoLabel = `T:${gT?gT.grupo:"-"} / P:${gP?gP.grupo:"-"}`;
    docenteLabel = `T: ${gT?gT.docente:"-"} · P: ${gP?gP.docente:"-"}`;
  } else {
    const gid = asign;
    if(!actas[gid]) return;
    const nota = parseFloat(calcularDefinitivaGrupo(gid, codigo));
    if(isNaN(nota)) return;
    definitivaFinal = nota;
    aprobadaFinal = definitivaFinal >= 3.0;
    const g = (gruposPrograma[materia]||[]).find(x=>x.id===gid);
    grupoLabel = g ? g.grupo : "";
    docenteLabel = g ? g.docente : "";
  }

  const entradaHistorial = {
    creditos: creditosMateria,
    definitiva: parseFloat(definitivaFinal.toFixed(1)),
    aprobada: aprobadaFinal,
    grupo: grupoLabel,
    docente: docenteLabel
  };

  const historial = getHistorial();
  if(!historial[codigo]) historial[codigo] = {};
  historial[codigo][materia] = entradaHistorial;

  // Si este curso llenaba un cupo de electiva del pensum, la nota también se refleja
  // ahí (con el nombre del curso real entre paréntesis) para que el cupo cuente como
  // aprobado y el estudiante pueda avanzar de nivel.
  if(slotDeElectiva){
    historial[codigo][slotDeElectiva] = {
      ...entradaHistorial,
      cursoElegido: materia
    };
  }

  saveHistorial(historial);
}

function subirActas(programaNombre, grupoId, materia){
  pedirConfirmacion("Vas a subir las actas de \"" + materia + "\" — " + "las notas quedarán oficiales en el historial de cada estudiante. ¿Continuar?", function(){
    const estudiantes = estudiantesDeGrupo(programaNombre, materia, grupoId);

    const actas = getActas();
    actas[grupoId] = true;
    saveActas(actas);

    estudiantes.forEach(e=>{
      intentarPublicarHistorial(programaNombre, materia, e.codigo);
    });

    renderNotasDocente();
  });
}

function reabrirActas(grupoId){
  pedirConfirmacion("¿Reabrir las actas de este grupo para corregir notas? El estudiante seguirá viendo la última nota oficial hasta que subas actas de nuevo.", function(){
    const actas = getActas();
    actas[grupoId] = false;
    saveActas(actas);
    renderNotasDocente();
  });
}

function renderNotasDocente(){
  const programas = programasDelDocente();
  const todosLosGrupos = getGrupos();
  const notas = getNotas();
  const configTodo = getConfigEvaluacion();
  const actas = getActas();

  let secciones = "";
  programas.forEach(programaNombre=>{
    const grupos = todosLosGrupos[programaNombre] || {};
    Object.keys(grupos).forEach(materia=>{
      grupos[materia].forEach(g=>{
        if(g.docente !== usuarioActual.nombre) return;

        const estudiantes = estudiantesDeGrupo(programaNombre, materia, g.id);
        if(estudiantes.length===0) return; // sin estudiantes matriculados este semestre: no se muestra

        const items = configTodo[g.id] || [];
        const sumaPesos = items.reduce((a,it)=>a + (parseFloat(it.peso)||0), 0);
        const actasSubidas = !!actas[g.id];

        const listaItems = items.length
          ? items.map(it=>`
              <span class="chip-item ${it.tipo==='asistencia' ? 'chip-asistencia' : ''}">
                ${it.tipo==='asistencia' ? '✅ ' : ''}${it.nombre} (${it.peso}%)
                ${actasSubidas ? "" : `<span class="quitar-chip" onclick="eliminarItemEvaluacion('${g.id}','${it.id}')">✕</span>`}
              </span>
            `).join(" ")
          : `<span style="font-size:12px;color:#999">Aún no hay ítems de evaluación.</span>`;

        let filas;
        if(items.length===0){
          filas = `<tr><td colspan="3">Agrega al menos un ítem de evaluación para poder calificar.</td></tr>`;
        } else {
          filas = estudiantes.map(e=>{
            const celdasItems = items.map(it=>{
              if(it.tipo==="asistencia"){
                const v = calcularNotaAsistencia(g.id, e.codigo);
                return `<td><div class="celda-auto"><b>${v===null?"-":v.toFixed(1)}</b><br><span style="font-size:10px;color:#7c93a8">auto</span></div></td>`;
              }
              const notaItem = ((notas[g.id]||{})[e.codigo]||{})[it.id];
              return `<td><input type="number" min="0" max="5" step="0.1" class="input-nota"
                    id="nota_${g.id}_${e.codigo}_${it.id}"
                    value="${notaItem!==undefined?notaItem:""}"
                    onchange="guardarNotaItem('${g.id}','${e.codigo}','${it.id}', this.value)"
                    ${actasSubidas ? "disabled" : ""}></td>`;
            }).join("");

            return `<tr>
              <td>${e.codigo}</td>
              <td class="nombre-estudiante">${e.nombre}</td>
              ${celdasItems}
              <td class="celda-definitiva"><span id="definitiva_${g.id}_${e.codigo}">${calcularDefinitivaGrupo(g.id, e.codigo)}</span></td>
            </tr>`;
          }).join("");
        }

        const encabezadoItems = items.map(it=>`<th>${it.tipo==='asistencia'?'✅ ':''}${it.nombre}<br><span style="font-weight:normal;font-size:11px;opacity:.85">${it.peso}%</span></th>`).join("");

        const puedeSubirActas = sumaPesos===100 && estudiantes.length>0 && !actasSubidas;
        const etiquetaPrograma = programas.length>1 ? ` — <span style="font-size:12px;color:#666">${programaNombre}</span>` : "";
        const colorBarra = sumaPesos===100 ? '#1e5631' : sumaPesos>100 ? '#a83232' : '#e0a83a';

        secciones += `
          <div class="tarjeta-grupo-notas">
            <h3>${materia}${g.componente ? " ("+(g.componente==='Teorico'?'Teórico':'Práctico')+")" : ""} — ${g.grupo}${etiquetaPrograma} ${actasSubidas ? '<span class="badge" style="background:#1e5631">Actas subidas</span>' : ""}</h3>
            ${g.componente ? `<p style="font-size:12px;color:#666;margin:2px 0 10px 0">Esta es una materia Teórico/Práctico: la nota Definitiva del estudiante en su historial solo se publica cuando <b>ambos</b> componentes (Teórico y Práctico) ya tengan actas subidas, y solo queda <b>aprobada</b> si el promedio ponderado da 3.0 o más <b>Y</b> cada componente por separado también dio 3.0 o más (no basta con que el promedio compense un componente perdido).</p>` : ""}

            <div style="margin:10px 0">
              <b style="font-size:13px">Ítems de evaluación</b>
              <span style="font-size:12px;color:${sumaPesos===100?'#1e5631':'#a83232'};font-weight:bold"> — suma actual: ${sumaPesos}%</span>
              <div class="barra-suma-items"><div class="relleno" style="width:${Math.min(sumaPesos,100)}%;background:${colorBarra}"></div></div>
              ${listaItems}
            </div>

            ${actasSubidas ? "" : `
            <div id="avisoItems_${g.id}"></div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px;background:#f4f6f4;border-radius:8px;padding:10px">
              <input id="item_nombre_${g.id}" placeholder="Ej: Taller 1" style="width:180px">
              <input id="item_peso_${g.id}" type="number" min="1" max="100" placeholder="% (ej: 5)" style="width:110px">
              <label style="font-size:12px;display:flex;align-items:center;gap:4px">
                <input type="checkbox" id="item_asistencia_${g.id}"> Es el ítem de Asistencia (se calcula solo)
              </label>
              <button class="btn-secundario" style="width:auto;padding:8px 14px" onclick="agregarItemEvaluacion('${g.id}')">+ Agregar ítem</button>
            </div>`}

            <div style="overflow-x:auto">
              <table class="tabla-notas-docente">
                <tr><th>Código</th><th>Nombre</th>${encabezadoItems}<th>Definitiva</th></tr>
                ${filas}
              </table>
            </div>

            ${puedeSubirActas ? `<button onclick="subirActas('${programaNombre}','${g.id}','${materia.replace(/'/g,"\\'")}')">📤 Subir Actas</button>` : ""}
            ${actasSubidas ? `<button class="btn-secundario" onclick="reabrirActas('${g.id}')">Reabrir Actas</button>` : ""}
            ${(!actasSubidas && sumaPesos!==100) ? `<p style="font-size:12px;color:#999">El botón para subir actas aparece cuando los ítems sumen 100%.</p>` : ""}
          </div>
        `;
      });
    });
  });

  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Notas y Actas — ${usuarioActual.nombre}</h2>
    ${secciones || `<p style="color:#999">No tienes grupos con estudiantes matriculados este periodo.</p>`}
  `;
}

/* ======================================================================
   ASISTENCIA — DOCENTE (pasar lista) y ESTUDIANTE (consultar la suya)
   ====================================================================== */
function gruposConEstudiantesDelDocente(){
  const programas = programasDelDocente();
  const todosLosGrupos = getGrupos();
  let lista = [];
  programas.forEach(programaNombre=>{
    const grupos = todosLosGrupos[programaNombre] || {};
    Object.keys(grupos).forEach(materia=>{
      grupos[materia].forEach(g=>{
        if(g.docente !== usuarioActual.nombre) return;
        const estudiantes = estudiantesDeGrupo(programaNombre, materia, g.id);
        if(estudiantes.length===0) return;
        lista.push({programaNombre, materia, g, estudiantes});
      });
    });
  });
  return lista;
}

function renderAsistenciaDocente(grupoSeleccionado, fechaSeleccionada){
  const opcionesGrupos = gruposConEstudiantesDelDocente();

  if(opcionesGrupos.length===0){
    document.getElementById("contenido").innerHTML = `
      <h2 class="panel-title">Asistencia</h2>
      <p style="color:#999">No tienes grupos con estudiantes matriculados este periodo.</p>
    `;
    return;
  }

  const activo = opcionesGrupos.find(o=>o.g.id===grupoSeleccionado) || opcionesGrupos[0];
  const fecha = fechaSeleccionada || new Date().toISOString().slice(0,10);

  const asistencia = getAsistencia();
  const registrosFecha = (asistencia[activo.g.id] || {})[fecha] || {};

  const opcionesSelectGrupo = opcionesGrupos.map(o=>{
    const etiquetaComponente = o.g.componente ? " ("+(o.g.componente==='Teorico'?'Teórico':'Práctico')+")" : "";
    return `<option value="${o.g.id}" ${o.g.id===activo.g.id?'selected':''}>${o.materia}${etiquetaComponente} — ${o.g.grupo}</option>`;
  }).join("");

  const filas = activo.estudiantes.map(e=>{
    const estadoActual = registrosFecha[e.codigo] || "";
    return `<tr>
      <td>${e.codigo}</td>
      <td style="text-align:left">${e.nombre}</td>
      <td>
        <select onchange="marcarAsistenciaYRefrescar('${activo.g.id}','${fecha}','${e.codigo}', this.value)">
          <option value="" ${estadoActual===""?"selected":""}>— Sin marcar —</option>
          <option value="presente" ${estadoActual==="presente"?"selected":""}>✅ Presente</option>
          <option value="tardanza" ${estadoActual==="tardanza"?"selected":""}>🕒 Tardanza</option>
          <option value="falla" ${estadoActual==="falla"?"selected":""}>❌ Falla</option>
        </select>
      </td>
    </tr>`;
  }).join("");

  const fechasRegistradas = Object.keys(asistencia[activo.g.id] || {}).sort().reverse();

  document.getElementById("contenido").innerHTML = `
    <h2 class="panel-title">Asistencia</h2>
    <p style="font-size:13px;color:#666;max-width:560px">
      Para que la asistencia cuente en la nota final de una materia, primero crea un ítem de evaluación
      marcado como "Es el ítem de Asistencia" en <b>Notas</b> — ahí defines qué porcentaje vale (ej: 5%).
    </p>
    <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:end;margin-bottom:14px">
      <div>
        <label style="font-size:12px;display:block">Grupo</label>
        <select id="selGrupoAsistencia" onchange="renderAsistenciaDocente(this.value, document.getElementById('selFechaAsistencia').value)">${opcionesSelectGrupo}</select>
      </div>
      <div>
        <label style="font-size:12px;display:block">Fecha de la clase</label>
        <input type="date" id="selFechaAsistencia" value="${fecha}" onchange="renderAsistenciaDocente(document.getElementById('selGrupoAsistencia').value, this.value)">
      </div>
    </div>
    <table style="max-width:600px">
      <tr><th>Código</th><th>Nombre</th><th>Estado</th></tr>
      ${filas}
    </table>
    ${fechasRegistradas.length ? `
      <p style="font-size:12px;color:#666;margin-top:14px">Clases ya registradas para este grupo (click para revisar/editar):<br>
        ${fechasRegistradas.map(f=>`<span class="badge" style="background:#607d8b;cursor:pointer;margin:2px" onclick="renderAsistenciaDocente('${activo.g.id}','${f}')">${f}</span>`).join(" ")}
      </p>` : ""}
  `;
}

function marcarAsistenciaYRefrescar(grupoId, fecha, codigo, estado){
  marcarAsistencia(grupoId, fecha, codigo, estado);
}

function renderAsistenciaEstudiante(){
  const e = getEstudiantes()[usuarioActual.codigo];
  const registro = getMatriculas()[e.codigo];
  const gruposPrograma = getGrupos()[e.programa] || {};
  const asistencia = getAsistencia();
  const configTodo = getConfigEvaluacion();

  if(!registro || !registro.materias || Object.keys(registro.materias).length===0){
    document.getElementById("contenido").innerHTML = `
      <h2 class="panel-title">Mi Asistencia</h2>
      <p style="color:#999">No tienes materias matriculadas este periodo.</p>
    `;
    return;
  }

  let secciones = "";
  Object.keys(registro.materias).forEach(materia=>{
    const asign = registro.materias[materia];
    const listaGrupos = gruposPrograma[materia] || [];
    const entradas = (asign && typeof asign==="object")
      ? [["Teórico", asign.Teorico], ["Práctico", asign.Practico]].filter(([,id])=>id)
      : [[null, asign]];

    entradas.forEach(([etiquetaComponente, grupoId])=>{
      const g = listaGrupos.find(x=>x.id===grupoId);
      if(!g) return;

      const fechasGrupo = asistencia[grupoId] || {};
      const fechasOrdenadas = Object.keys(fechasGrupo).sort();
      const filasFechas = fechasOrdenadas.map(fecha=>{
        const estado = fechasGrupo[fecha][e.codigo];
        if(estado===undefined) return "";
        const etiqueta = estado==="presente" ? "✅ Presente" : estado==="tardanza" ? "🕒 Tardanza" : "❌ Falla";
        return `<tr><td>${fecha}</td><td>${etiqueta}</td></tr>`;
      }).join("");

      const notaAsistencia = calcularNotaAsistencia(grupoId, e.codigo);
      const itemAsistencia = (configTodo[grupoId]||[]).find(it=>it.tipo==="asistencia");

      secciones += `
        <div style="border:1px solid #ddd;border-radius:8px;padding:14px;margin-bottom:16px;background:#fafafa">
          <h3 style="margin-top:0">${materia}${etiquetaComponente ? " ("+etiquetaComponente+")" : ""} — Grupo ${g.grupo}</h3>
          <p style="font-size:13px;color:#666">Docente: <b>${g.docente||"-"}</b></p>
          ${filasFechas ? `
            <table style="max-width:400px">
              <tr><th>Fecha</th><th>Estado</th></tr>
              ${filasFechas}
            </table>
          ` : `<p style="font-size:13px;color:#999">Aún no se ha registrado asistencia en esta materia.</p>`}
          ${notaAsistencia!==null ? `
            <p style="font-size:13px">Nota de asistencia (escala 0-5): <b>${notaAsistencia.toFixed(1)}</b>
              ${itemAsistencia ? ` — vale <b>${itemAsistencia.peso}%</b> de la nota final` : ""}
            </p>
          ` : ""}
        </div>
      `;
    });
  });

  document.getElementById("contenido").innerHTML = `
    <h2 class="panel-title">Mi Asistencia</h2>
    ${secciones || `<p style="color:#999">No se encontró información de asistencia para tus materias.</p>`}
  `;
}

function guardarNotaItem(grupoId, codigo, itemId, valor){
  const notas = getNotas();
  if(!notas[grupoId]) notas[grupoId]={};
  if(!notas[grupoId][codigo]) notas[grupoId][codigo]={};
  notas[grupoId][codigo][itemId] = valor;
  // Guardado local igual que siempre, pero el envío a Supabase es un
  // upsert puntual de esta única fila (no saveNotas, que reemplazaría
  // TODA la tabla en cada casilla calificada).
  localStorage.setItem("uan_notas", JSON.stringify(notas));
  empujarFilaNotaASupabase(grupoId, codigo, notas[grupoId][codigo]);

  // Recalcular en vivo, sin redibujar toda la tabla
  const definitivaEl = document.getElementById(`definitiva_${grupoId}_${codigo}`);
  if(definitivaEl) definitivaEl.textContent = calcularDefinitivaGrupo(grupoId, codigo);
}

function renderCambiarPasswordDocente(){
  document.getElementById("contenido").innerHTML=`
    <h2 class="panel-title">Cambiar Contraseña</h2>
    <div id="avisoPasswordDoc"></div>
    <div class="form-grid">
      <div class="full"><label>Contraseña actual</label><input id="pwd_actual" type="password"></div>
      <div class="full"><label>Nueva contraseña</label><input id="pwd_nueva" type="password"></div>
      <div class="full"><label>Confirmar nueva contraseña</label><input id="pwd_confirmar" type="password"></div>
      <div class="full"><button onclick="guardarPasswordPropiaDocente()">Actualizar Contraseña</button></div>
    </div>
  `;
}

function guardarPasswordPropiaDocente(){
  const docentes = getDocentes();
  const d = docentes[usuarioActual.programa].find(x=>x.id===usuarioActual.id);
  const actual=document.getElementById("pwd_actual").value;
  const nueva=document.getElementById("pwd_nueva").value;
  const confirmar=document.getElementById("pwd_confirmar").value;

  if(actual!==d.password){
    document.getElementById("avisoPasswordDoc").innerHTML=`<div class="aviso aviso-error">La contraseña actual no es correcta.</div>`;
    return;
  }
  if(!nueva || nueva!==confirmar){
    document.getElementById("avisoPasswordDoc").innerHTML=`<div class="aviso aviso-error">La nueva contraseña y su confirmación no coinciden.</div>`;
    return;
  }

  d.password = nueva;
  saveDocentes(docentes);
  document.getElementById("avisoPasswordDoc").innerHTML=`<div class="aviso">✅ Contraseña actualizada correctamente.</div>`;
  document.getElementById("pwd_actual").value="";
  document.getElementById("pwd_nueva").value="";
  document.getElementById("pwd_confirmar").value="";
}
