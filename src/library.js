// Project library — reads project.json files from the workspace dir.

const fs = require('fs');
const path = require('path');

function listProjects(workspaceDir) {
  const root = path.join(workspaceDir, 'projects');
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const id of fs.readdirSync(root)) {
    const meta = path.join(root, id, 'project.json');
    if (!fs.existsSync(meta)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(meta, 'utf8'));
      // Verify video still exists
      if (j.videoPath && fs.existsSync(j.videoPath)) {
        out.push(j);
      }
    } catch (_) {}
  }
  return out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

function getProject(workspaceDir, id) {
  const meta = path.join(workspaceDir, 'projects', id, 'project.json');
  if (!fs.existsSync(meta)) return null;
  try { return JSON.parse(fs.readFileSync(meta, 'utf8')); }
  catch (_) { return null; }
}

function deleteProject(workspaceDir, id) {
  const dir = path.join(workspaceDir, 'projects', id);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

module.exports = { listProjects, getProject, deleteProject };
