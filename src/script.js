"use strict";

/* ═══════════════════════════════════════════════════════════
   1.  ANIMATED GRAIN / NOISE BACKGROUND  (#noise-canvas)
   — Per-frame white noise (film grain) over a dark base
   — Each frame seeds differ → grain flickers like analog film
   — Subtle vignette darkens edges; grain intensity is mild
   ═══════════════════════════════════════════════════════════ */
(function initNoiseBg() {

  const canvas = document.getElementById("noise-canvas");

  /* Try WebGL for high-perf grain; fall back to 2D Canvas */
  const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");

  if (!gl) {
    /* ── 2D Canvas fallback ── */
    const ctx = canvas.getContext("2d");
    function resize2d() { canvas.width=innerWidth; canvas.height=innerHeight; }
    resize2d();
    window.addEventListener("resize", resize2d);
    (function draw2d() {
      const w=canvas.width, h=canvas.height;
      const img=ctx.createImageData(w,h);
      const d=img.data;
      for (let i=0;i<d.length;i+=4) {
        const g=Math.random()*38|0;
        d[i]=d[i+1]=d[i+2]=g; d[i+3]=255;
      }
      ctx.putImageData(img,0,0);
      requestAnimationFrame(draw2d);
    })();
    return;
  }

  /* ── WebGL path ── */
  function resize() {
    /* render at half-res for perf — CSS stretches it */
    canvas.width  = Math.ceil(innerWidth  / 2);
    canvas.height = Math.ceil(innerHeight / 2);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  resize();
  window.addEventListener("resize", resize);

  const VS = `attribute vec2 a_pos; void main(){ gl_Position=vec4(a_pos,0.,1.); }`;

  /* Grain shader:
     - hash21: fast per-pixel random seeded by (uv + frame offset)
     - base: near-black (#0b0b0e) with a touch of cool blue
     - grain: additive white noise, intensity ~12% max
     - vignette: smooth radial darkening at edges
     - Each frame u_seed changes → grain never repeats */
  const FS = `
precision highp float;
uniform float u_seed;
uniform vec2  u_res;

float hash21(vec2 p){
  p=fract(p*vec2(234.34,435.345)+u_seed);
  p+=dot(p,p+34.23);
  return fract(p.x*p.y);
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;

  /* ── film grain: white noise, mild intensity ── */
  float g = hash21(gl_FragCoord.xy);
  /* remap to [-1,1] then scale — signed grain looks more filmic */
  float grain = (g - 0.5) * 0.13;

  vec3 col = vec3(grain);

  /* ── subtle vignette ── */
  vec2 vig = uv * 2.0 - 1.0;
  float v = 1.0 - dot(vig, vig) * 0.42;
  col *= clamp(v, 0.0, 1.0);

  col = clamp(col, 0.0, 1.0);
  gl_FragColor = vec4(col, col.r);
}`;

  function makeShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s); return s;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, makeShader(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, makeShader(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog); gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const uSeed = gl.getUniformLocation(prog, "u_seed");
  const uRes  = gl.getUniformLocation(prog, "u_res");

  (function draw() {
    /* unique seed every frame → grain flickers */
    gl.uniform1f(uSeed, Math.random() * 999.0);
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    requestAnimationFrame(draw);
  })();

})();


/* ═══════════════════════════════════════════════════════════
   2.  FLUID SIMULATION  (#fluid-canvas)
   — Navier-Stokes velocity + dye, reacts to cursor movement
   ═══════════════════════════════════════════════════════════ */
(function initFluid() {

  const canvas = document.getElementById("fluid-canvas");
  canvas.width  = canvas.clientWidth;
  canvas.height = canvas.clientHeight;

  const config = {
    SIM_RESOLUTION:       128,
    DYE_RESOLUTION:       512,
    DENSITY_DISSIPATION:  0.97,
    VELOCITY_DISSIPATION: 0.96,
    PRESSURE_DISSIPATION: 0.8,
    PRESSURE_ITERATIONS:  20,
    CURL:                 18,
    SPLAT_RADIUS:         0.28,
    BLOOM:                true,
    BLOOM_ITERATIONS:     4,
    BLOOM_RESOLUTION:     256,
    BLOOM_INTENSITY:      0.4,
    BLOOM_THRESHOLD:      0.6,
    BLOOM_SOFT_KNEE:      0.7,
  };

  function pointerPrototype() {
    this.id = -1; this.x = 0; this.y = 0;
    this.dx = 0;  this.dy = 0;
    this.down = false; this.moved = false;
    this.color = { r:0.1, g:0.0, b:0.3 };
  }
  let pointers = [new pointerPrototype()];
  let splatStack = [], bloomFBOs = [];

  const params = { alpha:true, depth:false, stencil:false, antialias:false, preserveDrawingBuffer:false };
  let gl = canvas.getContext("webgl2", params);
  const isWebGL2 = !!gl;
  if (!isWebGL2) gl = canvas.getContext("webgl", params) || canvas.getContext("experimental-webgl", params);

  let halfFloat, supportLinear;
  if (isWebGL2) {
    gl.getExtension("EXT_color_buffer_float");
    supportLinear = gl.getExtension("OES_texture_float_linear");
  } else {
    halfFloat     = gl.getExtension("OES_texture_half_float");
    supportLinear = gl.getExtension("OES_texture_half_float_linear");
  }
  gl.clearColor(0,0,0,1);
  const halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : halfFloat.HALF_FLOAT_OES;

  function getSupportedFormat(inF, fmt, type) {
    if (!supportRTF(inF, fmt, type)) {
      if (inF === gl.R16F)  return getSupportedFormat(gl.RG16F,   gl.RG,   type);
      if (inF === gl.RG16F) return getSupportedFormat(gl.RGBA16F, gl.RGBA, type);
      return null;
    }
    return { internalFormat:inF, format:fmt };
  }
  function supportRTF(inF, fmt, type) {
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, inF, 4, 4, 0, fmt, type, null);
    const fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  }

  let formatRGBA, formatRG, formatR;
  if (isWebGL2) {
    formatRGBA = getSupportedFormat(gl.RGBA16F, gl.RGBA, halfFloatTexType);
    formatRG   = getSupportedFormat(gl.RG16F,   gl.RG,   halfFloatTexType);
    formatR    = getSupportedFormat(gl.R16F,    gl.RED,  halfFloatTexType);
  } else {
    formatRGBA = getSupportedFormat(gl.RGBA, gl.RGBA, halfFloatTexType);
    formatRG   = getSupportedFormat(gl.RGBA, gl.RGBA, halfFloatTexType);
    formatR    = getSupportedFormat(gl.RGBA, gl.RGBA, halfFloatTexType);
  }

  function compileShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s); return s;
  }
  class GLProgram {
    constructor(vs, fs) {
      this.uniforms = {}; this.program = gl.createProgram();
      gl.attachShader(this.program, vs); gl.attachShader(this.program, fs);
      gl.linkProgram(this.program);
      const n = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
      for (let i=0;i<n;i++) {
        const name = gl.getActiveUniform(this.program, i).name;
        this.uniforms[name] = gl.getUniformLocation(this.program, name);
      }
    }
    bind() { gl.useProgram(this.program); }
  }

  const baseVert     = compileShader(gl.VERTEX_SHADER, `precision highp float;attribute vec2 aPosition;varying vec2 vUv;varying vec2 vL;varying vec2 vR;varying vec2 vT;varying vec2 vB;uniform vec2 texelSize;void main(){vUv=aPosition*.5+.5;vL=vUv-vec2(texelSize.x,0.);vR=vUv+vec2(texelSize.x,0.);vT=vUv+vec2(0.,texelSize.y);vB=vUv-vec2(0.,texelSize.y);gl_Position=vec4(aPosition,0.,1.);}`);
  const clearFrag    = compileShader(gl.FRAGMENT_SHADER,`precision mediump float;precision mediump sampler2D;varying highp vec2 vUv;uniform sampler2D uTexture;uniform float value;void main(){gl_FragColor=value*texture2D(uTexture,vUv);}`);
  const colorFrag    = compileShader(gl.FRAGMENT_SHADER,`precision mediump float;uniform vec4 color;void main(){gl_FragColor=color;}`);
  const displayFrag  = compileShader(gl.FRAGMENT_SHADER,`precision highp float;precision highp sampler2D;varying vec2 vUv;uniform sampler2D uTexture;void main(){vec3 C=texture2D(uTexture,vUv).rgb;float a=max(C.r,max(C.g,C.b));gl_FragColor=vec4(C,a);}`);
  const bloomPreFrag = compileShader(gl.FRAGMENT_SHADER,`precision mediump float;precision mediump sampler2D;varying vec2 vUv;uniform sampler2D uTexture;uniform vec3 curve;uniform float threshold;void main(){vec3 c=texture2D(uTexture,vUv).rgb;float br=max(c.r,max(c.g,c.b));float rq=clamp(br-curve.x,0.,curve.y);rq=curve.z*rq*rq;c*=max(rq,br-threshold)/max(br,.0001);gl_FragColor=vec4(c,0.);}`);
  const bloomBlurFrag= compileShader(gl.FRAGMENT_SHADER,`precision mediump float;precision mediump sampler2D;varying vec2 vL;varying vec2 vR;varying vec2 vT;varying vec2 vB;uniform sampler2D uTexture;void main(){vec4 s=vec4(0.);s+=texture2D(uTexture,vL);s+=texture2D(uTexture,vR);s+=texture2D(uTexture,vT);s+=texture2D(uTexture,vB);s*=.25;gl_FragColor=s;}`);
  const bloomFinFrag = compileShader(gl.FRAGMENT_SHADER,`precision mediump float;precision mediump sampler2D;varying vec2 vL;varying vec2 vR;varying vec2 vT;varying vec2 vB;uniform sampler2D uTexture;uniform float intensity;void main(){vec4 s=vec4(0.);s+=texture2D(uTexture,vL);s+=texture2D(uTexture,vR);s+=texture2D(uTexture,vT);s+=texture2D(uTexture,vB);s*=.25;gl_FragColor=s*intensity;}`);
  const displayBloomFrag=compileShader(gl.FRAGMENT_SHADER,`precision highp float;precision highp sampler2D;varying vec2 vUv;uniform sampler2D uTexture;uniform sampler2D uBloom;void main(){vec3 C=texture2D(uTexture,vUv).rgb;vec3 bloom=texture2D(uBloom,vUv).rgb;bloom=pow(bloom.rgb,vec3(1./2.2));C+=bloom;float a=max(C.r,max(C.g,C.b));gl_FragColor=vec4(C,a);}`);
  const splatFrag    = compileShader(gl.FRAGMENT_SHADER,`precision highp float;precision highp sampler2D;varying vec2 vUv;uniform sampler2D uTarget;uniform float aspectRatio;uniform vec3 color;uniform vec2 point;uniform float radius;void main(){vec2 p=vUv-point.xy;p.x*=aspectRatio;vec3 splat=exp(-dot(p,p)/radius)*color;vec3 base=texture2D(uTarget,vUv).xyz;gl_FragColor=vec4(base+splat,1.);}`);
  const advFrag      = compileShader(gl.FRAGMENT_SHADER,`precision highp float;precision highp sampler2D;varying vec2 vUv;uniform sampler2D uVelocity;uniform sampler2D uSource;uniform vec2 texelSize;uniform float dt;uniform float dissipation;void main(){vec2 coord=vUv-dt*texture2D(uVelocity,vUv).xy*texelSize;gl_FragColor=dissipation*texture2D(uSource,coord);gl_FragColor.a=1.;}`);
  const advManFrag   = compileShader(gl.FRAGMENT_SHADER,`precision highp float;precision highp sampler2D;varying vec2 vUv;uniform sampler2D uVelocity;uniform sampler2D uSource;uniform vec2 texelSize;uniform vec2 dyeTexelSize;uniform float dt;uniform float dissipation;vec4 bilerp(sampler2D sam,vec2 uv,vec2 ts){vec2 st=uv/ts-.5;vec2 iuv=floor(st);vec2 fuv=fract(st);vec4 a=texture2D(sam,(iuv+vec2(.5,.5))*ts);vec4 b=texture2D(sam,(iuv+vec2(1.5,.5))*ts);vec4 c=texture2D(sam,(iuv+vec2(.5,1.5))*ts);vec4 d=texture2D(sam,(iuv+vec2(1.5,1.5))*ts);return mix(mix(a,b,fuv.x),mix(c,d,fuv.x),fuv.y);}void main(){vec2 coord=vUv-dt*bilerp(uVelocity,vUv,texelSize).xy*texelSize;gl_FragColor=dissipation*bilerp(uSource,coord,dyeTexelSize);gl_FragColor.a=1.;}`);
  const divFrag      = compileShader(gl.FRAGMENT_SHADER,`precision mediump float;precision mediump sampler2D;varying highp vec2 vUv;varying highp vec2 vL;varying highp vec2 vR;varying highp vec2 vT;varying highp vec2 vB;uniform sampler2D uVelocity;void main(){float L=texture2D(uVelocity,vL).x;float R=texture2D(uVelocity,vR).x;float T=texture2D(uVelocity,vT).y;float B=texture2D(uVelocity,vB).y;vec2 C=texture2D(uVelocity,vUv).xy;if(vL.x<0.){L=-C.x;}if(vR.x>1.){R=-C.x;}if(vT.y>1.){T=-C.y;}if(vB.y<0.){B=-C.y;}float div=.5*(R-L+T-B);gl_FragColor=vec4(div,0.,0.,1.);}`);
  const curlFrag     = compileShader(gl.FRAGMENT_SHADER,`precision mediump float;precision mediump sampler2D;varying highp vec2 vUv;varying highp vec2 vL;varying highp vec2 vR;varying highp vec2 vT;varying highp vec2 vB;uniform sampler2D uVelocity;void main(){float L=texture2D(uVelocity,vL).y;float R=texture2D(uVelocity,vR).y;float T=texture2D(uVelocity,vT).x;float B=texture2D(uVelocity,vB).x;float vorticity=R-L-T+B;gl_FragColor=vec4(.5*vorticity,0.,0.,1.);}`);
  const vortFrag     = compileShader(gl.FRAGMENT_SHADER,`precision highp float;precision highp sampler2D;varying vec2 vUv;varying vec2 vL;varying vec2 vR;varying vec2 vT;varying vec2 vB;uniform sampler2D uVelocity;uniform sampler2D uCurl;uniform float curl;uniform float dt;void main(){float L=texture2D(uCurl,vL).x;float R=texture2D(uCurl,vR).x;float T=texture2D(uCurl,vT).x;float B=texture2D(uCurl,vB).x;float C=texture2D(uCurl,vUv).x;vec2 force=.5*vec2(abs(T)-abs(B),abs(R)-abs(L));force/=length(force)+.0001;force*=curl*C;force.y*=-1.;vec2 vel=texture2D(uVelocity,vUv).xy;gl_FragColor=vec4(vel+force*dt,0.,1.);}`);
  const presFrag     = compileShader(gl.FRAGMENT_SHADER,`precision mediump float;precision mediump sampler2D;varying highp vec2 vUv;varying highp vec2 vL;varying highp vec2 vR;varying highp vec2 vT;varying highp vec2 vB;uniform sampler2D uPressure;uniform sampler2D uDivergence;void main(){float L=texture2D(uPressure,vL).x;float R=texture2D(uPressure,vR).x;float T=texture2D(uPressure,vT).x;float B=texture2D(uPressure,vB).x;float divergence=texture2D(uDivergence,vUv).x;float pressure=(L+R+B+T-divergence)*.25;gl_FragColor=vec4(pressure,0.,0.,1.);}`);
  const gradFrag     = compileShader(gl.FRAGMENT_SHADER,`precision mediump float;precision mediump sampler2D;varying highp vec2 vUv;varying highp vec2 vL;varying highp vec2 vR;varying highp vec2 vT;varying highp vec2 vB;uniform sampler2D uPressure;uniform sampler2D uVelocity;void main(){float L=texture2D(uPressure,vL).x;float R=texture2D(uPressure,vR).x;float T=texture2D(uPressure,vT).x;float B=texture2D(uPressure,vB).x;vec2 velocity=texture2D(uVelocity,vUv).xy;velocity.xy-=vec2(R-L,T-B);gl_FragColor=vec4(velocity,0.,1.);}`);

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,-1,1,1,1,1,-1]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0,1,2,0,2,3]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
  gl.enableVertexAttribArray(0);
  const blit = dest => { gl.bindFramebuffer(gl.FRAMEBUFFER, dest); gl.drawElements(gl.TRIANGLES,6,gl.UNSIGNED_SHORT,0); };

  const clearProg    = new GLProgram(baseVert, clearFrag);
  const colorProg    = new GLProgram(baseVert, colorFrag);
  const displayProg  = new GLProgram(baseVert, displayFrag);
  const displayBloom = new GLProgram(baseVert, displayBloomFrag);
  const bloomPreProg = new GLProgram(baseVert, bloomPreFrag);
  const bloomBlurProg= new GLProgram(baseVert, bloomBlurFrag);
  const bloomFinProg = new GLProgram(baseVert, bloomFinFrag);
  const splatProg    = new GLProgram(baseVert, splatFrag);
  const advProg      = new GLProgram(baseVert, supportLinear ? advFrag : advManFrag);
  const divProg      = new GLProgram(baseVert, divFrag);
  const curlProg     = new GLProgram(baseVert, curlFrag);
  const vortProg     = new GLProgram(baseVert, vortFrag);
  const presProg     = new GLProgram(baseVert, presFrag);
  const gradProg     = new GLProgram(baseVert, gradFrag);

  let simW, simH, dyeW, dyeH, density, velocity, divergence, curl, pressure, bloom;

  function getRes(res) {
    let ar = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (ar < 1) ar = 1/ar;
    let max=Math.round(res*ar), min=Math.round(res);
    return gl.drawingBufferWidth > gl.drawingBufferHeight ? {width:max,height:min} : {width:min,height:max};
  }
  function createFBO(w,h,inF,fmt,type,param) {
    gl.activeTexture(gl.TEXTURE0);
    const tex=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,tex);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,param);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,param);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D,0,inF,w,h,0,fmt,type,null);
    const fbo=gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);
    gl.viewport(0,0,w,h); gl.clear(gl.COLOR_BUFFER_BIT);
    return { texture:tex,fbo,width:w,height:h, attach(id){gl.activeTexture(gl.TEXTURE0+id);gl.bindTexture(gl.TEXTURE_2D,tex);return id;} };
  }
  function createDoubleFBO(w,h,inF,fmt,type,param) {
    let f1=createFBO(w,h,inF,fmt,type,param), f2=createFBO(w,h,inF,fmt,type,param);
    return { get read(){return f1;},set read(v){f1=v;},get write(){return f2;},set write(v){f2=v;},swap(){let t=f1;f1=f2;f2=t;} };
  }
  function resizeFBO(target,w,h,inF,fmt,type,param) {
    const n=createFBO(w,h,inF,fmt,type,param);
    clearProg.bind(); gl.uniform1i(clearProg.uniforms.uTexture,target.attach(0)); gl.uniform1f(clearProg.uniforms.value,1); blit(n.fbo);
    return n;
  }
  function resizeDoubleFBO(target,w,h,inF,fmt,type,param) {
    target.read=resizeFBO(target.read,w,h,inF,fmt,type,param);
    target.write=createFBO(w,h,inF,fmt,type,param);
    return target;
  }
  function initFBOs() {
    const simRes=getRes(config.SIM_RESOLUTION), dyeRes=getRes(config.DYE_RESOLUTION);
    simW=simRes.width; simH=simRes.height; dyeW=dyeRes.width; dyeH=dyeRes.height;
    const texType=halfFloatTexType, rgba=formatRGBA, rg=formatRG, r=formatR;
    const filt=supportLinear?gl.LINEAR:gl.NEAREST;
    if (!density)  density  = createDoubleFBO(dyeW,dyeH,rgba.internalFormat,rgba.format,texType,filt);
    else           density  = resizeDoubleFBO(density,dyeW,dyeH,rgba.internalFormat,rgba.format,texType,filt);
    if (!velocity) velocity = createDoubleFBO(simW,simH,rg.internalFormat,rg.format,texType,filt);
    else           velocity = resizeDoubleFBO(velocity,simW,simH,rg.internalFormat,rg.format,texType,filt);
    divergence = createFBO(simW,simH,r.internalFormat,r.format,texType,gl.NEAREST);
    curl       = createFBO(simW,simH,r.internalFormat,r.format,texType,gl.NEAREST);
    pressure   = createDoubleFBO(simW,simH,r.internalFormat,r.format,texType,gl.NEAREST);
    const bRes=getRes(config.BLOOM_RESOLUTION);
    bloom = createFBO(bRes.width,bRes.height,rgba.internalFormat,rgba.format,texType,filt);
    bloomFBOs.length=0;
    for (let i=0;i<config.BLOOM_ITERATIONS;i++) {
      let w=bRes.width>>(i+1), h=bRes.height>>(i+1);
      if (w<2||h<2) break;
      bloomFBOs.push(createFBO(w,h,rgba.internalFormat,rgba.format,texType,filt));
    }
  }

  function splat(x,y,dx,dy,color) {
    gl.viewport(0,0,simW,simH);
    splatProg.bind();
    gl.uniform1i(splatProg.uniforms.uTarget,velocity.read.attach(0));
    gl.uniform1f(splatProg.uniforms.aspectRatio,canvas.width/canvas.height);
    gl.uniform2f(splatProg.uniforms.point,x/canvas.width,1-y/canvas.height);
    gl.uniform3f(splatProg.uniforms.color,dx,-dy,1);
    gl.uniform1f(splatProg.uniforms.radius,config.SPLAT_RADIUS/100);
    blit(velocity.write.fbo); velocity.swap();
    gl.viewport(0,0,dyeW,dyeH);
    gl.uniform1i(splatProg.uniforms.uTarget,density.read.attach(0));
    gl.uniform3f(splatProg.uniforms.color,color.r,color.g,color.b);
    blit(density.write.fbo); density.swap();
  }
  function multipleSplats(n) {
    for (let i=0;i<n;i++) {
      const c=generateColor(); c.r*=10;c.g*=10;c.b*=10;
      splat(canvas.width*Math.random(),canvas.height*Math.random(),1000*(Math.random()-.5),1000*(Math.random()-.5),c);
    }
  }
  function step(dt) {
    gl.disable(gl.BLEND); gl.viewport(0,0,simW,simH);
    curlProg.bind(); gl.uniform2f(curlProg.uniforms.texelSize,1/simW,1/simH); gl.uniform1i(curlProg.uniforms.uVelocity,velocity.read.attach(0)); blit(curl.fbo);
    vortProg.bind(); gl.uniform2f(vortProg.uniforms.texelSize,1/simW,1/simH); gl.uniform1i(vortProg.uniforms.uVelocity,velocity.read.attach(0)); gl.uniform1i(vortProg.uniforms.uCurl,curl.attach(1)); gl.uniform1f(vortProg.uniforms.curl,config.CURL); gl.uniform1f(vortProg.uniforms.dt,dt); blit(velocity.write.fbo); velocity.swap();
    divProg.bind(); gl.uniform2f(divProg.uniforms.texelSize,1/simW,1/simH); gl.uniform1i(divProg.uniforms.uVelocity,velocity.read.attach(0)); blit(divergence.fbo);
    clearProg.bind(); gl.uniform1i(clearProg.uniforms.uTexture,pressure.read.attach(0)); gl.uniform1f(clearProg.uniforms.value,config.PRESSURE_DISSIPATION); blit(pressure.write.fbo); pressure.swap();
    presProg.bind(); gl.uniform2f(presProg.uniforms.texelSize,1/simW,1/simH); gl.uniform1i(presProg.uniforms.uDivergence,divergence.attach(0));
    for (let i=0;i<config.PRESSURE_ITERATIONS;i++) { gl.uniform1i(presProg.uniforms.uPressure,pressure.read.attach(1)); blit(pressure.write.fbo); pressure.swap(); }
    gradProg.bind(); gl.uniform2f(gradProg.uniforms.texelSize,1/simW,1/simH); gl.uniform1i(gradProg.uniforms.uPressure,pressure.read.attach(0)); gl.uniform1i(gradProg.uniforms.uVelocity,velocity.read.attach(1)); blit(velocity.write.fbo); velocity.swap();
    advProg.bind(); gl.uniform2f(advProg.uniforms.texelSize,1/simW,1/simH);
    if (!supportLinear) gl.uniform2f(advProg.uniforms.dyeTexelSize,1/simW,1/simH);
    const velId=velocity.read.attach(0); gl.uniform1i(advProg.uniforms.uVelocity,velId); gl.uniform1i(advProg.uniforms.uSource,velId); gl.uniform1f(advProg.uniforms.dt,dt); gl.uniform1f(advProg.uniforms.dissipation,config.VELOCITY_DISSIPATION); blit(velocity.write.fbo); velocity.swap();
    gl.viewport(0,0,dyeW,dyeH);
    if (!supportLinear) gl.uniform2f(advProg.uniforms.dyeTexelSize,1/dyeW,1/dyeH);
    gl.uniform1i(advProg.uniforms.uVelocity,velocity.read.attach(0)); gl.uniform1i(advProg.uniforms.uSource,density.read.attach(1)); gl.uniform1f(advProg.uniforms.dissipation,config.DENSITY_DISSIPATION); blit(density.write.fbo); density.swap();
  }
  function applyBloom(source, dest) {
    if (bloomFBOs.length<2) return;
    let last=dest; gl.disable(gl.BLEND);
    bloomPreProg.bind();
    const knee=config.BLOOM_THRESHOLD*config.BLOOM_SOFT_KNEE+.0001;
    gl.uniform3f(bloomPreProg.uniforms.curve,config.BLOOM_THRESHOLD-knee,knee*2,.25/knee);
    gl.uniform1f(bloomPreProg.uniforms.threshold,config.BLOOM_THRESHOLD);
    gl.uniform1i(bloomPreProg.uniforms.uTexture,source.attach(0));
    gl.viewport(0,0,last.width,last.height); blit(last.fbo);
    bloomBlurProg.bind();
    for (let i=0;i<bloomFBOs.length;i++) {
      const d=bloomFBOs[i]; gl.uniform2f(bloomBlurProg.uniforms.texelSize,1/last.width,1/last.height); gl.uniform1i(bloomBlurProg.uniforms.uTexture,last.attach(0)); gl.viewport(0,0,d.width,d.height); blit(d.fbo); last=d;
    }
    gl.blendFunc(gl.ONE,gl.ONE); gl.enable(gl.BLEND);
    for (let i=bloomFBOs.length-2;i>=0;i--) {
      const b=bloomFBOs[i]; gl.uniform2f(bloomBlurProg.uniforms.texelSize,1/last.width,1/last.height); gl.uniform1i(bloomBlurProg.uniforms.uTexture,last.attach(0)); gl.viewport(0,0,b.width,b.height); blit(b.fbo); last=b;
    }
    gl.disable(gl.BLEND);
    bloomFinProg.bind(); gl.uniform2f(bloomFinProg.uniforms.texelSize,1/last.width,1/last.height); gl.uniform1i(bloomFinProg.uniforms.uTexture,last.attach(0)); gl.uniform1f(bloomFinProg.uniforms.intensity,config.BLOOM_INTENSITY); gl.viewport(0,0,dest.width,dest.height); blit(dest.fbo);
  }
  function render(target) {
    applyBloom(density.read,bloom);
    gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA); gl.enable(gl.BLEND);
    const w=target==null?gl.drawingBufferWidth:dyeW;
    const h=target==null?gl.drawingBufferHeight:dyeH;
    gl.viewport(0,0,w,h);
    colorProg.bind(); gl.uniform4f(colorProg.uniforms.color,0,0,0,1); blit(target);
    const prog=config.BLOOM?displayBloom:displayProg;
    prog.bind(); gl.uniform1i(prog.uniforms.uTexture,density.read.attach(0));
    if (config.BLOOM) gl.uniform1i(prog.uniforms.uBloom,bloom.attach(1));
    blit(target);
  }
  function generateColor() {
    const h=Math.random(), i=Math.floor(h*6), f=h*6-i, q=1-f, t=f;
    let r,g,b;
    switch(i%6){case 0:r=1,g=t,b=0;break;case 1:r=q,g=1,b=0;break;case 2:r=0,g=1,b=t;break;case 3:r=0,g=q,b=1;break;case 4:r=t,g=0,b=1;break;case 5:r=1,g=0,b=q;break;}
    return {r:r*.15,g:g*.15,b:b*.15};
  }

  /* expose splat to cursor system */
  const ptr = pointers[0];
  window._fluidSplat = function(clientX, clientY, dx, dy) {
    ptr.x=clientX; ptr.y=clientY;
    ptr.dx=dx*5; ptr.dy=dy*5;
    ptr.down=true; ptr.moved=true;
    if (!ptr.color||Math.random()<.02) ptr.color=generateColor();
  };

  initFBOs();
  multipleSplats(parseInt(Math.random()*12)+6);

  let last=0;
  (function update(now) {
    const dt=Math.min((now-last)/1000,.016); last=now;
    if (canvas.width!==canvas.clientWidth||canvas.height!==canvas.clientHeight) {
      canvas.width=canvas.clientWidth; canvas.height=canvas.clientHeight; initFBOs();
    }
    if (splatStack.length>0) multipleSplats(splatStack.pop());
    for (const p of pointers) if (p.moved){ splat(p.x,p.y,p.dx,p.dy,p.color); p.moved=false; }
    step(.016); render(null);
    requestAnimationFrame(update);
  })(0);

  window.addEventListener("keydown", e => { if(e.key===" ") splatStack.push(parseInt(Math.random()*12)+5); });

})();


/* ═══════════════════════════════════════════════════════════
   3.  CURSOR  — dot only, no ring
   ═══════════════════════════════════════════════════════════ */
(function initCursor() {
  const dot    = document.getElementById("c-dot");
  const glWrap = document.getElementById("gl-wrap");
  let rawX=-200, rawY=-200, prevX=-200, prevY=-200;

  function inGl(x,y) {
    const r=glWrap.getBoundingClientRect();
    return x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom;
  }

  document.addEventListener("mousemove", e => {
    const dx=e.clientX-prevX, dy=e.clientY-prevY;
    prevX=rawX; prevY=rawY;
    rawX=e.clientX; rawY=e.clientY;

    dot.style.left = rawX+"px";
    dot.style.top  = rawY+"px";
    inGl(rawX,rawY) ? dot.classList.add("zone-gl") : dot.classList.remove("zone-gl");

    /* forward to fluid only when outside gl-wrap */
    if (!inGl(rawX,rawY) && window._fluidSplat) {
      window._fluidSplat(rawX, rawY, dx, dy);
    }
  });

  document.addEventListener("touchmove", e => {
    e.preventDefault();
    const t=e.touches[0];
    rawX=t.clientX; rawY=t.clientY;
    dot.style.left=rawX+"px"; dot.style.top=rawY+"px";
    if (window._fluidSplat) window._fluidSplat(rawX,rawY,rawX-prevX,rawY-prevY);
    prevX=rawX; prevY=rawY;
  }, {passive:false});

})();


/* ═══════════════════════════════════════════════════════════
   4.  LIQUID REVEAL  (gl-wrap — Three.js)
   ═══════════════════════════════════════════════════════════ */
(function initReveal() {

  const VERT=`varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position,1.0);}`;
  const FRAG=`
precision highp float;
uniform sampler2D uLayerA;uniform sampler2D uLayerB;
uniform vec2 uMouse;uniform vec2 uPrev;uniform float uTime;uniform float uRadius;uniform float uAspect;
varying vec2 vUv;
vec3 mod289v3(vec3 x){return x-floor(x*(1./289.))*289.;}
vec2 mod289v2(vec2 x){return x-floor(x*(1./289.))*289.;}
vec3 permuteV(vec3 x){return mod289v3((x*34.+1.)*x);}
float snoise(vec2 v){
  const vec4 C=vec4(.211324865405187,.366025403784439,-.577350269189626,.024390243902439);
  vec2 i=floor(v+dot(v,C.yy));vec2 x0=v-i+dot(i,C.xx);
  vec2 i1=(x0.x>x0.y)?vec2(1.,0.):vec2(0.,1.);
  vec4 x12=x0.xyxy+C.xxzz;x12.xy-=i1;i=mod289v2(i);
  vec3 p=permuteV(permuteV(i.y+vec3(0.,i1.y,1.))+i.x+vec3(0.,i1.x,1.));
  vec3 m=max(.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.);
  m=m*m;m=m*m;vec3 x2=2.*fract(p*C.www)-1.;vec3 h=abs(x2)-.5;
  vec3 ox=floor(x2+.5);vec3 a0=x2-ox;
  m*=1.79284291400159-.85373472095314*(a0*a0+h*h);
  vec3 g;g.x=a0.x*x0.x+h.x*x0.y;g.yz=a0.yz*x12.xz+h.yz*x12.yw;
  return 130.*dot(m,g);}
void main(){
  vec2 uv=vUv;vec2 d=uv-uMouse;d.x*=uAspect;float dist=length(d);
  vec2 vel=uMouse-uPrev;float spd=length(vel)*uAspect;float t=uTime;
  float n1=snoise(vec2(uv.x*2.1+t*.16,uv.y*2.1-t*.12))*.08;
  float n2=snoise(vec2(uv.x*4.8-t*.26+1.7,uv.y*4.8+t*.21+.9))*.032;
  float n3=snoise(vec2(uv.x*10.+t*.45+3.1,uv.y*10.-t*.38+2.4))*.012;
  float stretch=dot(normalize(d+.0001),vel)*2.*min(spd*14.,1.);
  float r=uRadius+n1+n2+n3+stretch+spd*.20;
  float mask=1.-smoothstep(r-.024,r+.024,dist);
  float ca=.004*mask;
  vec4 colA;colA.r=texture2D(uLayerA,uv+vec2(ca,0.)).r;colA.g=texture2D(uLayerA,uv).g;colA.b=texture2D(uLayerA,uv-vec2(ca,0.)).b;colA.a=1.;
  vec4 colB=texture2D(uLayerB,uv);vec4 col=mix(colA,colB,mask);
  float vig=1.-smoothstep(.5,1.25,length((uv-.5)*vec2(uAspect,1.)));
  col.rgb*=mix(.68,1.,vig);gl_FragColor=col;
  }`;

  const wrap=document.getElementById("gl-wrap");
  const canvas=document.getElementById("gl");
  function sz(){
    const isMobile = window.innerWidth <= 768;
    let s;
    if (isMobile) {
      s = Math.round(window.innerHeight * 0.5);
    } else {
      s = Math.min(Math.round(window.innerWidth*.50), 860);
    }
    return{w:s,h:s};
  }
  let{w,h}=sz(); canvas.width=w;canvas.height=h;

  const renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  renderer.setSize(w,h);
  renderer.setClearColor(0x000000, 0);

  const scene=new THREE.Scene();
  const camera=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
  const uniforms={
    uLayerA:{value:null},uLayerB:{value:null},
    uMouse:{value:new THREE.Vector2(.5,.5)},uPrev:{value:new THREE.Vector2(.5,.5)},
    uTime:{value:0},uRadius:{value:.24},uAspect:{value:1},
  };
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2,2),
    new THREE.ShaderMaterial({vertexShader:VERT,fragmentShader:FRAG,uniforms})));

  const loader=new THREE.TextureLoader();
  loader.load("src/assets/photo-1.png",
    t=>{t.minFilter=THREE.LinearMipmapLinearFilter;t.magFilter=THREE.LinearFilter;t.wrapS=THREE.ClampToEdgeWrapping;t.wrapT=THREE.ClampToEdgeWrapping;uniforms.uLayerA.value=t;});
  loader.load("src/assets/photo-2.png",
    t=>{t.minFilter=THREE.LinearMipmapLinearFilter;t.magFilter=THREE.LinearFilter;t.wrapS=THREE.ClampToEdgeWrapping;t.wrapT=THREE.ClampToEdgeWrapping;uniforms.uLayerB.value=t;});

  let mx=.5,my=.5,cx=.5,cy=.5,px=.5,py=.5;
  function toUV(ex,ey){const r=wrap.getBoundingClientRect();return{lx:Math.max(0,Math.min(1,(ex-r.left)/r.width)),ly:Math.max(0,Math.min(1,1-(ey-r.top)/r.height))};}
  document.addEventListener("mousemove",e=>{const{lx,ly}=toUV(e.clientX,e.clientY);mx=lx;my=ly;});
  document.addEventListener("touchmove",e=>{const{lx,ly}=toUV(e.touches[0].clientX,e.touches[0].clientY);mx=lx;my=ly;},{passive:false});

  function lerp(a,b,t){return a+(b-a)*t;}
  const clock=new THREE.Clock();
  (function animate(){
    requestAnimationFrame(animate);
    const dt=clock.getDelta(),k=1-Math.exp(-dt*7);
    px=cx;py=cy;cx=lerp(cx,mx,k);cy=lerp(cy,my,k);
    uniforms.uPrev.value.set(px,py);
    uniforms.uMouse.value.set(cx,cy);
    uniforms.uTime.value=clock.getElapsedTime();
    renderer.render(scene,camera);
  })();

  window.addEventListener("resize",()=>{
    const{w:nw,h:nh}=sz();
    canvas.width=nw;canvas.height=nh;
    renderer.setSize(nw,nh);uniforms.uAspect.value=nw/nh;
  });

})();

/* ═══════════════════════════════════════════════════════════
   5.  HAMBURGER MENU  (nav-menu)
   ═══════════════════════════════════════════════════════════ */

const hamburger = document.querySelector(".hamburger");
const navMenu = document.querySelector("nav ul");

// Buka/tutup menu saat hamburger diklik
hamburger.addEventListener("click", () => {
  hamburger.classList.toggle("active");
  navMenu.classList.toggle("active");
});

// Tutup menu saat salah satu link diklik
document.querySelectorAll("nav ul li a").forEach(n => n.addEventListener("click", () => {
  hamburger.classList.remove("active");
  navMenu.classList.remove("active");
}));


/* ═══════════════════════════════════════════════════════════
   6.  ANIMATED TEXT  (animated-text)
   ═══════════════════════════════════════════════════════════ */
 var typing=new Typed(".text", {
       strings: ["", "Design Engineer", "Product Thinking", "Frontend Architect", "Generative Design", "AI Augmentation"],
       typeSpeed: 80,
       backSpeed: 30,
       loop: true,
       showCursor: false,
   });

/* ═══════════════════════════════════════════════════════════
   7.  FORM SUBMISSION  (formsubmit)
   ═══════════════════════════════════════════════════════════ */

// Menunggu seluruh HTML selesai dimuat oleh browser sebelum menjalankan script
document.addEventListener('DOMContentLoaded', function() {
    const contactForm = document.getElementById('contact-form');
    const myFormDiv = document.getElementById('myForm');
    const myMessageDiv = document.getElementById('myMessage');
    const submitBtn = document.getElementById('submit-btn');

    // 1. PROSES SUBMIT FORM (AJAX)
    if (contactForm) {
        contactForm.addEventListener('submit', function(e) {
            e.preventDefault();
            e.stopPropagation();

            if (submitBtn) {
                submitBtn.innerText = "Sending...";
                submitBtn.disabled = true;
            }

            const formData = new FormData(contactForm);
            const object = {};
            formData.forEach((value, key) => object[key] = value);
            const json = JSON.stringify(object);

            fetch(contactForm.action, {
                method: contactForm.method,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: json
            })
            .then(response => {
                if (!response.ok) throw new Error('Network error');
                return response.json();
            })
            .then(data => {
                if (data.success === "true" || data.success === true) {
                    // Kosongkan isi input form
                    contactForm.reset();
                    // Sembunyikan form, munculkan pesan sukses
                    if (myFormDiv) myFormDiv.style.display = 'none';
                    if (myMessageDiv) myMessageDiv.style.display = 'block';
                } else {
                    alert('Error: ' + (data.message || 'Please try again.'));
                }
                resetButton();
            })
            .catch(error => {
                console.error('Error:', error);
                alert('Failed to send message.');
                resetButton();
            });
        });
    }

    function resetButton() {
        if (submitBtn) {
            submitBtn.innerText = "Send Message";
            submitBtn.disabled = false;
        }
    }

    // 2. RESET MODAL KETIKA DIKLIKK / DIBUKA KEMBALI
    // Fungsi untuk mengembalikan tampilan ke kondisi awal (myForm muncul)
    function resetModalState() {
        if (myFormDiv) myFormDiv.style.display = 'block';
        if (myMessageDiv) myMessageDiv.style.display = 'none';
    }

    // Deteksi jika user menutup modal atau membuka modal lewat perubahan URL Hash (#dialogForm)
    window.addEventListener('hashchange', function() {
        // Jika URL saat ini tidak mengandung '#dialogForm' (artinya modal ditutup/berpindah)
        if (window.location.hash !== '#dialogForm') {
            resetModalState();
        }
    });

    // Antisipasi tambahan: Reset langsung saat tombol close ber-class ".close" diklik
    const closeLink = document.querySelector('#dialogForm .close');
    if (closeLink) {
        closeLink.addEventListener('click', function() {
            resetModalState();
        });
    }
    
});

/* ═══════════════════════════════════════════════════════════
   8.  LOADING PAGE
   ═══════════════════════════════════════════════════════════ */
document.addEventListener("DOMContentLoaded", () => {
    // Seleksi elemen berdasarkan struktur baru
    const loadingArea = document.querySelector('.loading');
    const progressText = document.querySelector('.loading-progress');
    const mainContainer = document.querySelector('.container');
    
    let progress = 0;

    // 1. Jalankan simulasi angka naik bertahap sebelum page load selesai
    const counterInterval = setInterval(() => {
        if (progress < 90) {
            progress += Math.floor(Math.random() * 5) + 2; // Naik acak antara 2% - 6%
            if (progress > 90) progress = 90; // Batasi maksimal 90% sebelum benar-benar load
            progressText.innerText = progress + '%';
        }
    }, 100);

    // 2. Kejadian ketika seluruh aset halaman (gambar, stylesheet, dll) SELESAI dimuat
    window.addEventListener('load', () => {
        clearInterval(counterInterval); // Hentikan simulasi angka acak
        
        progress = 100;
        progressText.innerText = '100%';

        // Beri jeda visual singkat (400ms) agar user sempat melihat angka 100%
        setTimeout(() => {
          loadingArea.style.display = "none"; // Sembunyikan seluruh area loading
          mainContainer.style.display = "flex"; // Munculkan container utama
        }, 1000);
    });
});