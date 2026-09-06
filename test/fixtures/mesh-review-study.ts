/** Authored geometry for offline viewer tests. This is not Cube output or a game template. */
export function meshReviewStudyObj(): string {
  const lines: string[] = [];
  let count = 0;
  const vertex = (x: number, y: number, z: number) => {
    lines.push(`v ${x.toFixed(7)} ${y.toFixed(7)} ${z.toFixed(7)}`);
    return ++count;
  };
  const triangle = (a: number, b: number, c: number) => lines.push(`f ${a} ${b} ${c}`);
  function ring(
    name: string,
    radius: number,
    tube: number,
    axis: "y" | "z",
    height = 0,
    steps = 64,
  ) {
    lines.push(`o ${name}`);
    const base = count;
    for (let i = 0; i < steps; i++)
      for (let j = 0; j < 8; j++) {
        const a = (i / steps) * Math.PI * 2,
          b = (j / 8) * Math.PI * 2;
        const x = (radius + tube * Math.cos(b)) * Math.cos(a),
          y = tube * Math.sin(b),
          z = (radius + tube * Math.cos(b)) * Math.sin(a);
        if (axis === "y") vertex(x, y + height, z);
        else vertex(x, z + height, y);
      }
    const at = (i: number, j: number) => base + (i % steps) * 8 + (j % 8) + 1;
    for (let i = 0; i < steps; i++)
      for (let j = 0; j < 8; j++) {
        triangle(at(i, j), at(i + 1, j), at(i + 1, j + 1));
        triangle(at(i, j), at(i + 1, j + 1), at(i, j + 1));
      }
  }
  ring("Outer_gimbal", 2.6, 0.13, "z");
  ring("Inner_gimbal", 2.1, 0.1, "y");
  ring("Upper_collar", 0.68, 0.14, "y", 1.3, 32);
  ring("Lower_collar", 0.68, 0.14, "y", -1.3, 32);
  lines.push("o Crystal");
  const top = vertex(0, 1.75, 0),
    bottom = vertex(0, -1.75, 0),
    points: number[] = [];
  for (let i = 0; i < 8; i++)
    points.push(vertex(Math.cos((i * Math.PI) / 4) * 0.95, 0, Math.sin((i * Math.PI) / 4) * 0.95));
  for (let i = 0; i < 8; i++) {
    triangle(top, points[(i + 1) % 8]!, points[i]!);
    triangle(bottom, points[i]!, points[(i + 1) % 8]!);
  }
  return lines.join("\n") + "\n";
}
