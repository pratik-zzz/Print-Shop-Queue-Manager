(() => {
  const form = document.getElementById('jobForm');
  const progressContainer = document.getElementById('progressContainer');
  const progressBar = document.getElementById('progressBar');
  const progressText = document.getElementById('progressText');
  const tokenCard = document.getElementById('tokenCard');
  const tokenNumberEl = document.getElementById('tokenNumber');
  const tokenFileNameEl = document.getElementById('tokenFileName');
  const tokenSpecsEl = document.getElementById('tokenSpecs');
  const statusBanner = document.getElementById('statusBanner');
  const submitBtn = document.getElementById('submitBtn');
  const decBtn = document.getElementById('decCopies');
  const incBtn = document.getElementById('incCopies');
  const copiesInput = form.querySelector('input[name="copies"]');
  const pauseMessage = document.getElementById('pauseMessage');
  const upiQrSection = document.getElementById('upiQrSection');
  const upiQrImage = document.getElementById('upiQrImage');

  const UPI_NAME = 'Print Shop';

  let currentUpiId = '';

  let jobId = null;
  let statusTimer = null;

  const pageRangeAll = form.querySelector('input[name="page_range_mode"][value="all"]');
  const pageRangeCustom = form.querySelector('input[name="page_range_mode"][value="custom"]');
  const customPagesField = document.getElementById('customPagesField');
  const pageRangeInput = form.querySelector('input[name="page_range"]');

  pageRangeAll.addEventListener('change', () => {
    customPagesField.classList.add('hidden');
    pageRangeInput.value = '';
  });
  pageRangeCustom.addEventListener('change', () => {
    customPagesField.classList.remove('hidden');
  });

  decBtn.addEventListener('click', () => {
    const v = Math.max(1, parseInt(copiesInput.value, 10) - 1);
    copiesInput.value = v;
  });
  incBtn.addEventListener('click', () => {
    copiesInput.value = parseInt(copiesInput.value, 10) + 1;
  });

  async function checkPauseState() {
    try {
      const res = await fetch('/api/settings/pause');
      const data = await res.json();
      if (data.paused) {
        pauseMessage.classList.remove('hidden');
        form.classList.add('hidden');
        submitBtn.disabled = true;
      } else {
        pauseMessage.classList.add('hidden');
        form.classList.remove('hidden');
        submitBtn.disabled = false;
      }
    } catch (_) {}
  }

  async function fetchUpiSettings() {
    try {
      const res = await fetch('/api/settings/upi');
      const data = await res.json();
      currentUpiId = data.upi_id || '';
    } catch (_) {}
  }

  function resetFormState() {
    form.style.display = '';
    progressContainer.style.display = 'none';
    tokenCard.classList.add('hidden');
    upiQrSection.classList.add('hidden');
    progressBar.style.width = '0%';
    progressText.textContent = '0%';
    submitBtn.disabled = false;
    jobId = null;
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
  }

  function showTokenCard(token, customerName, fileName, colorMode, isDuplex, copies, pageRange) {
    tokenNumberEl.textContent = '#' + String(token).padStart(2, '0');
    tokenFileNameEl.textContent = fileName;
    const modeLabel = colorMode === 'color' ? 'Color' : 'Black & White';
    const sidesLabel = isDuplex === '1' ? 'Double-Sided' : 'Single-Sided';
    const pagesLabel = pageRange ? `Pages: ${pageRange}` : 'All Pages';
    tokenSpecsEl.textContent = `${modeLabel} \u2022 ${sidesLabel} \u2022 ${copies} copy${copies !== 1 ? 's' : ''} \u2022 ${pagesLabel}`;
    statusBanner.textContent = 'Waiting in Queue';
    statusBanner.className = 'px-4 py-2 rounded-lg bg-blue-100 text-blue-800 text-sm font-medium mb-4';
    tokenCard.classList.remove('hidden');

    const tokenStr = String(token).padStart(2, '0');

    // Validate UPI ID is set before generating QR
    if (!currentUpiId || !currentUpiId.includes('@')) {
      upiQrSection.classList.add('hidden');
      startStatusPoll();
      return;
    }

    // Build UPI deep-link with all parameter values properly encoded
    const upiPayload = `upi://pay?pa=${encodeURIComponent(currentUpiId)}&pn=${encodeURIComponent(UPI_NAME)}&tn=${encodeURIComponent('Token ' + tokenStr)}`;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(upiPayload)}`;
    upiQrImage.src = qrUrl;
    document.getElementById('upiIdText').textContent = currentUpiId;
    upiQrSection.classList.remove('hidden');

    startStatusPoll();
  }

  function startStatusPoll() {
    if (!jobId) return;
    statusTimer = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/status/${jobId}`);
        const data = await res.json();
        if (data.success && data.job && data.job.status === 'completed') {
          statusBanner.textContent = 'Ready for Pickup';
          statusBanner.className = 'px-4 py-2 rounded-lg bg-green-100 text-green-800 text-sm font-medium mb-4';
          clearInterval(statusTimer);
          statusTimer = null;
        }
      } catch (_) {}
    }, 5000);
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();

    const formData = new FormData(form);
    const file = formData.get('file');

    if (!file || file.size === 0) {
      alert('Please select a PDF file.');
      return;
    }
    const fileNameLower = file.name.toLowerCase();
    if (!fileNameLower.endsWith('.pdf')) {
      alert('Only PDF files are allowed.');
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      alert('File exceeds the 25 MB size limit.');
      return;
    }
    if (!formData.get('name') || !formData.get('name').trim()) {
      alert('Customer name is required.');
      return;
    }

    form.style.display = 'none';
    progressContainer.style.display = 'block';
    submitBtn.disabled = true;

    const xhr = new XMLHttpRequest();
    xhr.upload.addEventListener('progress', (ev) => {
      if (ev.lengthComputable) {
        const pct = Math.round((ev.loaded / ev.total) * 100);
        progressBar.style.width = pct + '%';
        progressText.textContent = `Uploading ${pct}%…`;
      }
    });

    xhr.addEventListener('load', () => {
      progressContainer.style.display = 'none';
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const res = JSON.parse(xhr.responseText);
          if (res.success && res.token != null) {
            jobId = res.jobId;
            showTokenCard(
              res.token,
              formData.get('name').trim(),
              file.name,
              formData.get('color_mode') || 'bw',
              formData.get('is_duplex') || '0',
              formData.get('copies') || '1',
              formData.get('page_range') || null
            );
          } else {
            if (res.error && res.error.includes('paused')) {
              pauseMessage.classList.remove('hidden');
              form.classList.remove('hidden');
              submitBtn.disabled = true;
            } else {
              alert(res.error || 'Upload failed.');
              resetFormState();
              form.style.display = '';
            }
          }
        } catch (_) {
          alert('Invalid server response.');
          resetFormState();
          form.style.display = '';
        }
      } else {
        alert('Upload failed: ' + (xhr.responseText || xhr.status));
        resetFormState();
        form.style.display = '';
      }
    });

    xhr.addEventListener('error', () => {
      progressContainer.style.display = 'none';
      resetFormState();
      form.style.display = '';
      alert('Network error while uploading.');
    });

    xhr.addEventListener('abort', () => {
      resetFormState();
      form.style.display = '';
    });

    xhr.open('POST', '/api/jobs');
    xhr.send(formData);
  });

  checkPauseState();
  fetchUpiSettings();
})();
