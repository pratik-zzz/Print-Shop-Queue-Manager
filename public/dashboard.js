(() => {
  const activeView = document.getElementById('activeView');
  const completedView = document.getElementById('completedView');
  const completedList = document.getElementById('completedList');
  const emptyState = document.getElementById('emptyState');
  const queueCountEl = document.getElementById('queueCount');
  const toggle = document.getElementById('viewCompletedToggle');
  const muteToggle = document.getElementById('muteToggle');
  const pauseQueueBtn = document.getElementById('pauseQueueBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsPanel = document.getElementById('settingsPanel');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');

  let activeJobs = [];
  let completedJobs = [];
  let previousActiveIds = new Set();
  let isMuted = false;
  let isPaused = false;
  let currentUpiId = '';
  let settingsOpen = false;

  const escHtml = (text) => {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  };

  const escAttr = (text) => String(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const timeAgo = (isoString) => {
    // SQLite stores DATETIME as "YYYY-MM-DD HH:MM:SS" in UTC.
    // Parse as UTC to avoid browser timezone offset issues.
    const date = new Date(isoString.replace(' ', 'T') + 'Z');
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    return new Date(isoString).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const tokenLabel = (n) => '#' + String(n).padStart(2, '0');

  const specBadges = (job) => {
    const modeBadge = job.color_mode === 'color'
      ? '<span class="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold border border-orange-200 bg-orange-50 text-orange-700">Color</span>'
      : '<span class="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold border border-slate-200 bg-slate-50 text-slate-600">B&W</span>';
    const sidesBadge = job.is_duplex
      ? '<span class="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold border border-orange-200 bg-orange-50 text-orange-700">Duplex</span>'
      : '<span class="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold border border-slate-200 bg-slate-50 text-slate-600">Single</span>';
    const copiesBadge = `<span class="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold border border-indigo-100 bg-indigo-50 text-indigo-700">Copies: ${job.copies}</span>`;
    const pagesBadge = job.page_range
      ? `<span class="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold border border-purple-100 bg-purple-50 text-purple-700">Pages: ${escHtml(job.page_range)}</span>`
      : '';
    return `${modeBadge}${sidesBadge}${copiesBadge}${pagesBadge}`;
  };

  const playDing = () => {
    if (isMuted) return;
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.3);
    } catch (_) {}
  };

  const jobCard = (job) => {
    const storedFile = job.stored_file || pathBasename(job.file_path || '');
    return `
      <article id="job-${job.id}" class="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3 job-slide">
        <div class="flex flex-col md:flex-row items-start md:items-center md:justify-between gap-2 w-full">
          <div class="flex items-center gap-3">
            <span class="text-2xl font-bold text-indigo-600 tracking-tight">${tokenLabel(job.token_number)}</span>
            <div>
              <div class="font-semibold text-slate-800">${escHtml(job.customer_name)}</div>
              <div class="text-xs text-slate-500">${timeAgo(job.created_at)}</div>
            </div>
          </div>
          <div class="flex gap-2 flex-wrap">${specBadges(job)}</div>
        </div>
        <div class="flex flex-col md:flex-row gap-2 w-full md:w-auto justify-end">
          <button onclick="window.app.openPrint('${escAttr(storedFile)}')"
            class="flex-1 md:flex-auto px-3 py-2 text-sm font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-lg hover:bg-slate-100 transition">
            Open &amp; Print
          </button>
          ${job.status === 'pending' ? `<button onclick="window.app.markDone(${job.id})"
            class="flex-1 md:flex-auto px-3 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition">
            Mark Done
          </button>` : ''}
        </div>
      </article>
    `;
  };

  const pathBasename = (p) => p.split('/').pop().split('\\').pop();

  const render = () => {
    const list = toggle.checked ? completedJobs : activeJobs;
    const container = toggle.checked ? completedList : activeView;

    container.innerHTML = '';
    if (list.length === 0) {
      activeView.classList.add('hidden');
      completedView.classList.add('hidden');
      emptyState.classList.remove('hidden');
      queueCountEl.textContent = '0 jobs pending';
      return;
    }

    emptyState.classList.add('hidden');
    if (toggle.checked) {
      activeView.classList.add('hidden');
      completedView.classList.remove('hidden');
      queueCountEl.textContent = `${activeJobs.length} job${activeJobs.length !== 1 ? 's' : ''} pending`;
    } else {
      completedView.classList.add('hidden');
      activeView.classList.remove('hidden');
      queueCountEl.textContent = `${list.length} job${list.length !== 1 ? 's' : ''} in queue`;
    }

    container.insertAdjacentHTML('beforeend', list.map(jobCard).join(''));
  };

  const fetchActive = async () => {
    try {
      const res = await fetch('/api/jobs/active');
      activeJobs = res.ok ? await res.json() : [];
    } catch (_) {
      activeJobs = [];
    }
  };

  const fetchCompleted = async () => {
    try {
      const res = await fetch('/api/jobs/completed');
      completedJobs = res.ok ? await res.json() : [];
    } catch (_) {
      completedJobs = [];
    }
  };

  const fetchPauseState = async () => {
    try {
      const res = await fetch('/api/settings/pause');
      const data = await res.json();
      isPaused = !!data.paused;
      pauseQueueBtn.textContent = isPaused ? 'Queue: Paused' : 'Queue: Open';
      pauseQueueBtn.className = isPaused
        ? 'px-3 py-1.5 text-sm font-medium bg-rose-50 text-rose-800 border border-rose-200 rounded-lg hover:bg-rose-100 transition'
        : 'px-3 py-1.5 text-sm font-medium bg-green-50 text-green-800 border border-green-200 rounded-lg hover:bg-green-100 transition';
    } catch (_) {}
  };

  const fetchUpiId = async () => {
    try {
      const res = await fetch('/api/settings/upi');
      const data = await res.json();
      currentUpiId = data.upi_id || '';
      const display = document.getElementById('upiIdDisplay');
      const input = document.getElementById('upiIdInput');
      const editMode = document.getElementById('upiEditMode');
      if (display) display.textContent = currentUpiId || 'Not set';
      // Only populate the input if the user is NOT actively editing
      if (input && editMode && editMode.classList.contains('hidden')) {
        input.value = currentUpiId;
      }
    } catch (_) {}
  };

  const saveUpiId = async () => {
    const input = document.getElementById('upiIdInput');
    const msg = document.getElementById('upiSaveMsg');
    const saveBtn = document.getElementById('saveUpiBtn');
    if (!input || !input.value.trim()) return;
    saveBtn.disabled = true;
    try {
      const res = await fetch('/api/settings/upi', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upi_id: input.value.trim() })
      });
      const data = await res.json();
      if (data.success) {
        currentUpiId = data.upi_id;
        document.getElementById('upiIdDisplay').textContent = currentUpiId;
        msg.classList.remove('hidden');
        setTimeout(() => msg.classList.add('hidden'), 2000);
        // Switch back to view mode
        document.getElementById('upiEditMode').classList.add('hidden');
        document.getElementById('upiViewMode').classList.remove('hidden');
      } else {
        alert(data.error || 'Failed to save UPI ID.');
      }
    } catch (_) {
      alert('Network error saving UPI ID.');
    } finally {
      saveBtn.disabled = false;
    }
  };

  const refresh = async () => {
    await Promise.all([fetchActive(), fetchCompleted(), fetchPauseState(), fetchUpiId()]);

    const currentActiveIds = new Set(activeJobs.map((j) => j.id));
    const newJobs = activeJobs.filter((j) => !previousActiveIds.has(j.id));
    if (newJobs.length > 0) {
      playDing();
    }
    previousActiveIds = currentActiveIds;

    render();
  };

  window.app = {
    openPrint: (fileName) => {
      window.open(`/uploads/${encodeURIComponent(fileName)}`, '_blank');
    },
    markDone: async (id) => {
      try {
        const res = await fetch(`/api/jobs/${id}/complete`, { method: 'PATCH' });
        if (res.ok) {
          await refresh();
        } else {
          alert('Could not mark job as done.');
        }
      } catch (_) {
        alert('Network error marking job as done.');
      }
    },
    togglePause: async () => {
      try {
        const res = await fetch('/api/settings/pause', { method: 'PATCH' });
        const data = await res.json();
        isPaused = data.paused;
        await refresh();
      } catch (_) {
        alert('Network error toggling queue pause.');
      }
    }
  };

  const toggleSettings = () => {
    settingsOpen = !settingsOpen;
    if (settingsOpen) {
      settingsPanel.classList.remove('hidden');
    } else {
      settingsPanel.classList.add('hidden');
    }
  };

  muteToggle.addEventListener('click', () => {
    isMuted = !isMuted;
    // Button text shows what clicking will DO next
    muteToggle.textContent = isMuted ? '🔇 Unmute' : '🔊 Mute';
    muteToggle.className = isMuted
      ? 'text-sm text-slate-400'
      : 'text-sm text-slate-600 hover:text-indigo-600';
  });

  pauseQueueBtn.addEventListener('click', () => {
    window.app.togglePause();
  });

  // UPI settings event listeners
  const editUpiBtn = document.getElementById('editUpiBtn');
  const saveUpiBtn = document.getElementById('saveUpiBtn');
  const cancelUpiBtn = document.getElementById('cancelUpiBtn');
  const upiViewMode = document.getElementById('upiViewMode');
  const upiEditMode = document.getElementById('upiEditMode');

  editUpiBtn.addEventListener('click', () => {
    upiViewMode.classList.add('hidden');
    upiEditMode.classList.remove('hidden');
  });

  cancelUpiBtn.addEventListener('click', () => {
    document.getElementById('upiIdInput').value = currentUpiId;
    upiEditMode.classList.add('hidden');
    upiViewMode.classList.remove('hidden');
  });

  saveUpiBtn.addEventListener('click', saveUpiId);

  settingsBtn.addEventListener('click', toggleSettings);
  closeSettingsBtn.addEventListener('click', toggleSettings);

  toggle.addEventListener('change', () => {
    refresh();
  });

  refresh();
  setInterval(refresh, 5000);
})();
