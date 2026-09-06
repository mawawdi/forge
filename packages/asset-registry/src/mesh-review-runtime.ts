import type { MeshReviewData } from "./mesh-review.js";

/** Serialized as fixed browser code after TypeScript compilation; keep dependencies inside. */
export function meshReviewRuntime(): void {
  const data = JSON.parse(document.getElementById("mesh-data")!.textContent!) as MeshReviewData;
  const canvas = document.getElementById("viewport") as HTMLCanvasElement;
  const status = document.getElementById("status")!;
  const gl = canvas.getContext("webgl", { antialias: true, alpha: false });
  if (!gl) {
    status.textContent =
      "3D preview unavailable: this browser did not provide WebGL. Geometry details remain available.";
    return;
  }
  const vertexSource = `attribute vec3 position; attribute vec3 normal;
    uniform vec3 offset; uniform vec2 rotation; uniform vec2 scale;
    varying vec3 faceNormal;
    void main(){vec3 p=position+offset;
      float c=cos(rotation.x),s=sin(rotation.x),a=cos(rotation.y),b=sin(rotation.y);
      p=vec3(c*p.x+s*p.z,p.y,-s*p.x+c*p.z);
      p=vec3(p.x,a*p.y-b*p.z,b*p.y+a*p.z);
      gl_Position=vec4(p.xy*scale,-p.z/20.0,1.0);faceNormal=normal;}`;
  const fragmentSource = `precision mediump float; varying vec3 faceNormal;
    uniform vec3 tint; uniform float shaded;
    void main(){float light=0.35+0.65*abs(dot(normalize(faceNormal),normalize(vec3(0.4,0.8,0.6))));
      gl_FragColor=vec4(tint*mix(1.0,light,shaded),1.0);}`;
  const resources: WebGLBuffer[] = [];
  const shaders: WebGLShader[] = [];
  let ownedProgram: WebGLProgram | undefined;
  const releaseGraphics = () => {
    for (const resource of resources) gl.deleteBuffer(resource);
    for (const resource of shaders) gl.deleteShader(resource);
    if (ownedProgram) gl.deleteProgram(ownedProgram);
  };
  try {
    const shader = (type: number, source: string) => {
      const result = gl.createShader(type);
      if (!result) throw new Error("Preview shader allocation failed");
      shaders.push(result);
      gl.shaderSource(result, source);
      gl.compileShader(result);
      if (!gl.getShaderParameter(result, gl.COMPILE_STATUS))
        throw new Error("Preview shader could not compile");
      return result;
    };
    let program: WebGLProgram;
    try {
      const allocated = gl.createProgram();
      if (!allocated) throw new Error("Preview program allocation failed");
      program = allocated;
      ownedProgram = allocated;
      const vertex = shader(gl.VERTEX_SHADER, vertexSource);
      const fragment = shader(gl.FRAGMENT_SHADER, fragmentSource);
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error("Preview shader could not link");
    } catch {
      releaseGraphics();
      status.textContent =
        "3D preview unavailable: graphics initialization failed. Geometry details remain available.";
      return;
    }
    gl.useProgram(program);
    const position = gl.getAttribLocation(program, "position");
    const normal = gl.getAttribLocation(program, "normal");
    const offset = gl.getUniformLocation(program, "offset");
    const rotation = gl.getUniformLocation(program, "rotation");
    const scale = gl.getUniformLocation(program, "scale");
    const tint = gl.getUniformLocation(program, "tint");
    const shaded = gl.getUniformLocation(program, "shaded");
    const axes = ["x", "y", "z"] as const;
    const extent = Math.max(
      ...axes.map((axis) => data.geometry.bounds.max[axis] - data.geometry.bounds.min[axis]),
    );
    const center = axes.map(
      (axis) => (data.geometry.bounds.max[axis] + data.geometry.bounds.min[axis]) / 2,
    );
    const normalize = (value: number, axis: number) => ((value - center[axis]!) * 2) / extent;
    const vertices = new Float32Array(data.geometry.triangleCount * 18);
    const partKey = (
      part: MeshReviewData["nativeImport"]["partition"]["chunks"][number]["part"],
    ) => (part.kind === "unlabelled" ? "unlabelled" : `${part.kind}-${part.name}`);
    const parts = new Map<
      string,
      { index: number; min: number[]; max: number[]; direction: number[] }
    >();
    const chunks = data.nativeImport.partition.chunks.map((chunk, index) => {
      const min = [Infinity, Infinity, Infinity],
        max = [-Infinity, -Infinity, -Infinity];
      const key = partKey(chunk.part);
      if (!parts.has(key))
        parts.set(key, { index: parts.size, min: [...min], max: [...max], direction: [0, 0, 0] });
      return { ...chunk, index, key, first: 0, center: [0, 0, 0], min, max };
    });
    let cursor = 0;
    for (const chunk of chunks) {
      chunk.first = cursor / 6;
      for (const triangle of chunk.triangleIds) {
        for (let corner = 0; corner < 3; corner++) {
          const source = data.triangleIndices[triangle * 3 + corner]! * 3;
          for (let axis = 0; axis < 3; axis++) {
            const value = normalize(data.positions[source + axis]!, axis);
            vertices[cursor++] = value;
            chunk.min[axis] = Math.min(chunk.min[axis]!, value);
            chunk.max[axis] = Math.max(chunk.max[axis]!, value);
          }
          for (let axis = 0; axis < 3; axis++)
            vertices[cursor++] = data.triangleNormals[triangle * 3 + axis]!;
        }
      }
      chunk.center = chunk.min.map((value, axis) => (value + chunk.max[axis]!) / 2);
      const part = parts.get(chunk.key)!;
      for (let axis = 0; axis < 3; axis++) {
        part.min[axis] = Math.min(part.min[axis]!, chunk.min[axis]!);
        part.max[axis] = Math.max(part.max[axis]!, chunk.max[axis]!);
      }
    }
    for (const part of parts.values()) {
      const middle = part.min.map((value, axis) => (value + part.max[axis]!) / 2);
      const magnitude = Math.hypot(...middle);
      const angle = part.index * 2.399963229728653;
      part.direction =
        magnitude > 0.05
          ? middle.map((value) => value / magnitude)
          : [Math.cos(angle) * 0.8, part.index % 2 ? 0.5 : -0.5, Math.sin(angle) * 0.8];
    }
    const buffer = (array: Float32Array) => {
      const result = gl.createBuffer();
      if (!result) throw new Error("Preview geometry allocation failed");
      resources.push(result);
      gl.bindBuffer(gl.ARRAY_BUFFER, result);
      gl.bufferData(gl.ARRAY_BUFFER, array, gl.STATIC_DRAW);
      // A bounded check at allocation, never a per-frame GPU synchronization.
      if (gl.getError() !== gl.NO_ERROR) throw new Error("Preview geometry upload failed");
      return result;
    };
    const meshBuffer = buffer(vertices);
    let wireBuffer: WebGLBuffer | undefined;
    // At most 72 MB of vertex buffers for the admitted 500,000-triangle review.
    const wire = () => {
      if (wireBuffer) return wireBuffer;
      const lines = new Float32Array(data.geometry.triangleCount * 18);
      let output = 0;
      for (let triangle = 0; triangle < vertices.length; triangle += 18)
        for (const corner of [0, 1, 1, 2, 2, 0])
          for (let axis = 0; axis < 3; axis++)
            lines[output++] = vertices[triangle + corner * 6 + axis]!;
      wireBuffer = buffer(lines);
      return wireBuffer;
    };
    const overlay: number[] = [];
    const box = (min: number[], max: number[]) => {
      for (let axis = 0; axis < 3; axis++) {
        const other = [0, 1, 2].filter((value) => value !== axis);
        for (let corner = 0; corner < 4; corner++) {
          const a = [...min],
            b = [...min];
          b[axis] = max[axis]!;
          for (let bit = 0; bit < 2; bit++)
            a[other[bit]!] = b[other[bit]!] = (corner & (1 << bit) ? max : min)[other[bit]!]!;
          overlay.push(...a, ...b);
        }
      }
    };
    const lo = axes.map((axis, i) => normalize(data.geometry.bounds.min[axis], i));
    const hi = axes.map((axis, i) => normalize(data.geometry.bounds.max[axis], i));
    box(lo, hi);
    const fromFitted = (value: number, axis: number) =>
      normalize((value - data.fit.translation[axes[axis]!]) / data.fit.scale, axis);
    box(
      axes.map((axis, i) => fromFitted(-data.envelope.size[axis] / 2, i)),
      axes.map((axis, i) => fromFitted(data.envelope.size[axis] / 2, i)),
    );
    box(
      axes.map((axis, i) => fromFitted(-data.envelope.size[axis] / 2 + data.envelope.clearance, i)),
      axes.map((axis, i) => fromFitted(data.envelope.size[axis] / 2 - data.envelope.clearance, i)),
    );
    const socketFirst = overlay.length / 3;
    for (const socket of data.sockets) {
      const p = axes.map((axis, i) =>
        normalize((socket.position[axis] - data.fit.translation[axis]) / data.fit.scale, i),
      );
      for (let axis = 0; axis < 3; axis++) {
        const a = [...p],
          b = [...p];
        a[axis]! -= 0.045;
        b[axis]! += 0.045;
        overlay.push(...a, ...b);
      }
    }
    const overlayBuffer = buffer(new Float32Array(overlay));
    const grid: number[] = [];
    for (let line = -10; line <= 10; line++) {
      const coordinate = line / 5;
      grid.push(
        -2,
        lo[1]! - 0.01,
        coordinate,
        2,
        lo[1]! - 0.01,
        coordinate,
        coordinate,
        lo[1]! - 0.01,
        -2,
        coordinate,
        lo[1]! - 0.01,
        2,
      );
    }
    const gridBuffer = buffer(new Float32Array(grid));
    let yaw = -0.65,
      pitch = 0.35,
      zoom = 1,
      explode = 0,
      selected = "all";
    let frame = 0,
      disposed = false;
    const boundsInput = document.getElementById("bounds") as HTMLInputElement;
    const wireInput = document.getElementById("wire") as HTMLInputElement;
    const socketsInput = document.getElementById("sockets") as HTMLInputElement;
    const palette = [
      [0.62, 0.75, 0.94],
      [0.39, 0.85, 0.78],
      [0.92, 0.7, 0.43],
      [0.77, 0.61, 0.92],
      [0.93, 0.54, 0.63],
      [0.57, 0.8, 0.91],
    ];
    const bind = (value: WebGLBuffer, stride: number) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, value);
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 3, gl.FLOAT, false, stride, 0);
      if (stride === 24) {
        gl.enableVertexAttribArray(normal);
        gl.vertexAttribPointer(normal, 3, gl.FLOAT, false, 24, 12);
      } else {
        gl.disableVertexAttribArray(normal);
        gl.vertexAttrib3f(normal, 0, 1, 0);
      }
    };
    const color = (value: number[]) => gl.uniform3f(tint, value[0]!, value[1]!, value[2]!);
    function draw() {
      try {
        render();
      } catch {
        dispose();
        canvas.dataset.rendered = "false";
        status.textContent =
          "3D preview stopped: graphics resources are unavailable. Geometry details remain available.";
      }
    }
    function render() {
      frame = 0;
      if (disposed) return;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.round(canvas.clientWidth * pixelRatio));
      const height = Math.max(1, Math.round(canvas.clientHeight * pixelRatio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl!.viewport(0, 0, width, height);
      gl!.clearColor(0.043, 0.056, 0.075, 1);
      gl!.clear(gl!.COLOR_BUFFER_BIT | gl!.DEPTH_BUFFER_BIT);
      gl!.enable(gl!.DEPTH_TEST);
      gl!.uniform2f(rotation, yaw, pitch);
      const size = 0.7 * zoom * Math.min(1, width / height);
      gl!.uniform2f(scale, (size * height) / width, size);
      gl!.uniform3f(offset, 0, 0, 0);
      gl!.uniform1f(shaded, 0);
      bind(gridBuffer, 12);
      color([0.105, 0.14, 0.18]);
      gl!.drawArrays(gl!.LINES, 0, grid.length / 3);
      bind(meshBuffer, 24);
      gl!.uniform1f(shaded, 1);
      gl!.enable(gl!.POLYGON_OFFSET_FILL);
      gl!.polygonOffset(1, 1);
      for (const chunk of chunks) {
        if (selected !== "all" && selected !== chunk.key) continue;
        const part = parts.get(chunk.key)!;
        gl!.uniform3f(
          offset,
          ...(part.direction.map((value) => value * explode) as [number, number, number]),
        );
        color(palette[part.index % palette.length]!);
        gl!.drawArrays(gl!.TRIANGLES, chunk.first, chunk.triangleCount * 3);
      }
      gl!.disable(gl!.POLYGON_OFFSET_FILL);
      gl!.uniform1f(shaded, 0);
      if (wireInput.checked) {
        bind(wire(), 12);
        color([0.13, 0.23, 0.3]);
        for (const chunk of chunks) {
          if (selected !== "all" && selected !== chunk.key) continue;
          gl!.uniform3f(
            offset,
            ...(parts.get(chunk.key)!.direction.map((value) => value * explode) as [
              number,
              number,
              number,
            ]),
          );
          gl!.drawArrays(gl!.LINES, chunk.first * 2, chunk.triangleCount * 6);
        }
      }
      gl!.uniform3f(offset, 0, 0, 0);
      bind(overlayBuffer, 12);
      if (boundsInput.checked) {
        color([0.42, 0.56, 0.74]);
        gl!.drawArrays(gl!.LINES, 0, 24);
        color([0.26, 0.35, 0.47]);
        gl!.drawArrays(gl!.LINES, 24, 24);
        color([0.88, 0.65, 0.36]);
        gl!.drawArrays(gl!.LINES, 48, 24);
      }
      if (socketsInput.checked) {
        gl!.disable(gl!.DEPTH_TEST);
        color([0.38, 0.95, 0.76]);
        gl!.drawArrays(gl!.LINES, socketFirst, overlay.length / 3 - socketFirst);
      }
      canvas.dataset.rendered = "true";
    }
    const invalidate = () => {
      if (!frame && !disposed) frame = requestAnimationFrame(draw);
    };
    const announce = (message: string) => {
      status.textContent = message;
      invalidate();
    };
    document.querySelectorAll<HTMLButtonElement>("[data-part]").forEach((button) =>
      button.addEventListener("click", () => {
        selected = button.dataset.part!;
        document
          .querySelectorAll("[data-part]")
          .forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
        announce(
          selected === "all" ? "Showing all parts" : `Isolated ${button.textContent!.trim()}`,
        );
      }),
    );
    document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) =>
      button.addEventListener("click", () => {
        const view = button.dataset.view;
        [yaw, pitch] =
          view === "front"
            ? [0, 0]
            : view === "side"
              ? [Math.PI / 2, 0]
              : view === "top"
                ? [0, Math.PI / 2]
                : [-0.65, 0.35];
        announce(`${button.textContent} view`);
      }),
    );
    const adjustZoom = (factor: number) => {
      zoom = Math.max(0.2, Math.min(5, zoom * factor));
      document.getElementById("zoom-value")!.textContent = `${Math.round(zoom * 100)}%`;
      invalidate();
    };
    document.getElementById("zoom-in")!.addEventListener("click", () => adjustZoom(1.2));
    document.getElementById("zoom-out")!.addEventListener("click", () => adjustZoom(1 / 1.2));
    document.getElementById("reset")!.addEventListener("click", () => {
      yaw = -0.65;
      pitch = 0.35;
      zoom = 1;
      explode = 0;
      selected = "all";
      document
        .querySelectorAll<HTMLButtonElement>("[data-part]")
        .forEach((item) => item.setAttribute("aria-pressed", String(item.dataset.part === "all")));
      (document.getElementById("explode") as HTMLInputElement).value = "0";
      document.getElementById("explode-value")!.textContent = "0%";
      adjustZoom(1);
      announce("View reset");
    });
    for (const input of [boundsInput, wireInput, socketsInput])
      input.addEventListener("change", invalidate);
    document.getElementById("explode")!.addEventListener("input", (event) => {
      explode = Number((event.target as HTMLInputElement).value) / 100;
      document.getElementById("explode-value")!.textContent = `${Math.round(explode * 100)}%`;
      invalidate();
    });
    document
      .getElementById("explode")!
      .addEventListener("change", () =>
        announce(
          "Exploded view changes display only. Bounds and sockets remain in the assembled frame.",
        ),
      );
    let drag: { id: number; x: number; y: number; yaw: number; pitch: number } | undefined;
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || drag) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, yaw, pitch };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      yaw = drag.yaw + (event.clientX - drag.x) * 0.008;
      pitch = Math.max(
        -Math.PI / 2,
        Math.min(Math.PI / 2, drag.pitch + (event.clientY - drag.y) * 0.008),
      );
      invalidate();
    });
    const endDrag = (event: PointerEvent) => {
      if (event.pointerId === drag?.id) drag = undefined;
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("lostpointercapture", endDrag);
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        adjustZoom(Math.exp(-event.deltaY * 0.001));
      },
      { passive: false },
    );
    canvas.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft") yaw -= 0.12;
      else if (event.key === "ArrowRight") yaw += 0.12;
      else if (event.key === "ArrowUp") pitch = Math.min(Math.PI / 2, pitch + 0.12);
      else if (event.key === "ArrowDown") pitch = Math.max(-Math.PI / 2, pitch - 0.12);
      else if (event.key === "+" || event.key === "=") adjustZoom(1.2);
      else if (event.key === "-") adjustZoom(1 / 1.2);
      else return;
      event.preventDefault();
      invalidate();
    });
    const observer = new ResizeObserver(invalidate);
    observer.observe(canvas);
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      releaseGraphics();
    };
    canvas.addEventListener("webglcontextlost", () => {
      dispose();
      status.textContent = "Graphics context lost. Reload this file to reopen the preview.";
    });
    window.addEventListener("pagehide", (event) => {
      if (!event.persisted) dispose();
    });
    announce("Geometry loaded. Drag to orbit, use arrow keys, or choose a view above.");
  } catch {
    releaseGraphics();
    canvas.dataset.rendered = "false";
    status.textContent =
      "3D preview unavailable: geometry resources could not be allocated. Geometry details remain available.";
  }
}
