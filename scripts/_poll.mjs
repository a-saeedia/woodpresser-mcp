const repo = "a-saeedia/woodpresser-mcp";
const headers = { "user-agent": "node" };
const sha = process.argv[2];
const wait = Number(process.argv[3] ?? 0);

if (wait) await new Promise((r) => setTimeout(r, wait * 1000));

const deadline = Date.now() + 8 * 60 * 1000;
let run;
while (Date.now() < deadline) {
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=5`, { headers });
  const data = await res.json();
  run = data.workflow_runs.find((r) => r.head_sha === sha) ?? data.workflow_runs[0];
  if (run.status === "completed") break;
  console.log(`waiting: ${run.head_sha.slice(0, 7)} ${run.status}`);
  await new Promise((r) => setTimeout(r, 20000));
}

console.log(`run #${run.run_number} ${run.head_sha.slice(0, 7)} ${run.status} | ${run.conclusion}`);
if (run.status === "completed") {
  const jobs = await (await fetch(`https://api.github.com/repos/${repo}/actions/runs/${run.id}/jobs`, { headers })).json();
  for (const job of jobs.jobs) {
    console.log(`  ${job.conclusion === "success" ? "OK  " : "FAIL"} ${job.name}`);
    for (const step of job.steps ?? []) {
      if (step.conclusion && !["success", "skipped"].includes(step.conclusion)) {
        console.log(`        step ${step.number}: ${step.name} -> ${step.conclusion}`);
      }
    }
  }
}
