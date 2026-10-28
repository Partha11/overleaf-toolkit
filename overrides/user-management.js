(function () {
	function getCsrfToken() {
		return (
			document.querySelector('input[name="_csrf"]')?.value ||
			document.querySelector('meta[name="ol-csrfToken"]')?.getAttribute('content') ||
			document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ||
			window.csrfToken ||
			''
		);
	}

	function showFlash(type, message, persistent) {
		const container = document.getElementById('flash-container');
		if (!container) return;
		const id = 'alert-' + Date.now();
		container.innerHTML = `
			<div id="${id}" class="alert alert-${type} alert-dismissible fade show shadow-sm" role="alert">
				${message}
				<button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
			</div>
		`;
		if (!persistent) {
			setTimeout(() => {
				const el = document.getElementById(id);
				if (el) el.classList.remove('show');
			}, 8000);
		}
	}

	function showLinkBanner(email, link) {
		const container = document.getElementById('flash-container');
		if (!container) return;
		container.innerHTML = `
			<div class="alert alert-info alert-dismissible fade show shadow-sm" role="alert">
				<div class="d-flex flex-column flex-md-row align-items-md-center justify-content-between gap-2">
					<div>
						<strong>Activation / Password Reset Link</strong> for <code>${email}</code>:
					</div>
					<div class="input-group input-group-sm" style="max-width: 600px;">
						<input type="text" class="form-control font-monospace" value="${link}" readonly onclick="this.select()">
						<button class="btn btn-primary btn-copy-inline" type="button" data-link="${link}">Copy Link</button>
					</div>
				</div>
				<button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
			</div>
		`;
		container.querySelector('.btn-copy-inline')?.addEventListener('click', function () {
			copyToClipboard(link, this);
		});
	}

	function copyToClipboard(text, btn) {
		const done = () => {
			if (btn) {
				const originalHtml = btn.innerHTML;
				const wasPrimary = btn.classList.contains('btn-outline-primary') || btn.classList.contains('btn-primary');
				btn.innerHTML = 'Copied!';
				btn.classList.add('btn-success');
				btn.classList.remove('btn-outline-secondary', 'btn-outline-primary', 'btn-primary');
				setTimeout(() => {
					btn.innerHTML = originalHtml;
					btn.classList.remove('btn-success');
					btn.classList.add(wasPrimary ? 'btn-primary' : 'btn-outline-secondary');
				}, 2000);
			}
			showFlash('success', 'Link copied to clipboard!');
		};

		if (navigator.clipboard && navigator.clipboard.writeText) {
			navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
		} else {
			fallbackCopy(text, done);
		}
	}

	function fallbackCopy(text, cb) {
		const textArea = document.createElement('textarea');
		textArea.value = text;
		textArea.style.position = 'fixed';
		textArea.style.left = '-9999px';
		document.body.appendChild(textArea);
		textArea.select();
		try {
			document.execCommand('copy');
			cb();
		} catch (err) {
			window.prompt('Copy link:', text);
		}
		document.body.removeChild(textArea);
	}

	function updateStats() {
		const rows = Array.from(document.querySelectorAll('#users-tbody tr[data-user-id]'));
		const total = rows.length;
		let active = 0, pending = 0, admins = 0;
		rows.forEach(r => {
			if (r.getAttribute('data-is-admin') === 'true') admins++;
			if (r.getAttribute('data-is-pending') === 'true') pending++;
			else active++;
		});
		const elTotal = document.getElementById('stat-total');
		const elActive = document.getElementById('stat-active');
		const elPending = document.getElementById('stat-pending');
		const elAdmins = document.getElementById('stat-admins');
		if (elTotal) elTotal.textContent = total;
		if (elActive) elActive.textContent = active;
		if (elPending) elPending.textContent = pending;
		if (elAdmins) elAdmins.textContent = admins;
		filterUsers();
	}

	function filterUsers() {
		const search = (document.getElementById('user-search')?.value || '').toLowerCase().trim();
		const roleFilter = document.getElementById('filter-role')?.value || 'all';
		const rows = document.querySelectorAll('#users-tbody tr[data-user-id]');
		let visibleCount = 0;

		rows.forEach(row => {
			const email = row.getAttribute('data-email') || '';
			const name = row.getAttribute('data-name') || '';
			const isAdmin = row.getAttribute('data-is-admin') === 'true';
			const isPending = row.getAttribute('data-is-pending') === 'true';

			const matchesSearch = !search || email.includes(search) || name.includes(search);
			let matchesFilter = true;
			if (roleFilter === 'admin') matchesFilter = isAdmin;
			else if (roleFilter === 'user') matchesFilter = !isAdmin;
			else if (roleFilter === 'active') matchesFilter = !isPending;
			else if (roleFilter === 'pending') matchesFilter = isPending;

			if (matchesSearch && matchesFilter) {
				row.style.display = '';
				visibleCount++;
			} else {
				row.style.display = 'none';
			}
		});

		const counter = document.getElementById('filtered-count');
		if (counter) counter.textContent = visibleCount;
		const noUsersMsg = document.getElementById('no-users-message');
		if (noUsersMsg) {
			if (visibleCount === 0) noUsersMsg.classList.remove('d-none');
			else noUsersMsg.classList.add('d-none');
		}
	}

	function init() {
		document.getElementById('user-search')?.addEventListener('input', filterUsers);
	document.getElementById('filter-role')?.addEventListener('change', filterUsers);

	// Action buttons on users table (Link / Make Admin / Delete)
	document.getElementById('users-tbody')?.addEventListener('click', async function (e) {
		const btnReset = e.target.closest('.btn-reset-link');
		const btnToggle = e.target.closest('.btn-toggle-admin');
		const btnDelete = e.target.closest('.btn-delete-user');

		if (btnReset) {
			const userId = btnReset.getAttribute('data-user-id');
			const email = btnReset.getAttribute('data-email');
			const csrfToken = getCsrfToken();
			btnReset.disabled = true;
			try {
				const res = await fetch(`/admin/user/${userId}/reset-password`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'X-Csrf-Token': csrfToken
					},
					body: JSON.stringify({ _csrf: csrfToken })
				});
				const data = await res.json();
				if (data.success && data.setNewPasswordUrl) {
					showLinkBanner(email || data.email, data.setNewPasswordUrl);
					copyToClipboard(data.setNewPasswordUrl, btnReset);
				} else {
					showFlash('danger', data.error || 'Failed to generate link.');
				}
			} catch (err) {
				showFlash('danger', 'Error generating link: ' + err.message);
			} finally {
				btnReset.disabled = false;
			}
		} else if (btnToggle) {
			const userId = btnToggle.getAttribute('data-user-id');
			const currentIsAdmin = btnToggle.getAttribute('data-is-admin') === 'true';
			const actionName = currentIsAdmin ? 'Demote from admin' : 'Promote to admin';
			if (!confirm(`Are you sure you want to ${actionName}?`)) return;

			const csrfToken = getCsrfToken();
			btnToggle.disabled = true;
			try {
				const res = await fetch(`/admin/user/${userId}/toggle-admin`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'X-Csrf-Token': csrfToken
					},
					body: JSON.stringify({ _csrf: csrfToken })
				});
				const data = await res.json();
				if (data.success) {
					const row = document.getElementById(`user-row-${userId}`);
					const newAdmin = data.isAdmin;
					if (row) {
						row.setAttribute('data-is-admin', newAdmin ? 'true' : 'false');
						const roleBadge = row.querySelector('.role-badge');
						if (roleBadge) {
							if (newAdmin) {
								roleBadge.className = 'badge bg-primary role-badge';
								roleBadge.textContent = 'Admin';
							} else {
								roleBadge.className = 'badge bg-secondary bg-opacity-25 text-dark role-badge';
								roleBadge.textContent = 'User';
							}
						}
					}
					btnToggle.setAttribute('data-is-admin', newAdmin ? 'true' : 'false');
					btnToggle.textContent = newAdmin ? 'Demote' : 'Make Admin';
					updateStats();
					showFlash('success', `User privileges updated successfully.`);
				} else {
					showFlash('danger', data.error || 'Failed to update privileges.');
				}
			} catch (err) {
				showFlash('danger', 'Error updating admin privileges: ' + err.message);
			} finally {
				btnToggle.disabled = false;
			}
		} else if (btnDelete) {
			const userId = btnDelete.getAttribute('data-user-id');
			const email = btnDelete.getAttribute('data-email');
			if (!confirm(`WARNING: Are you sure you want to delete user ${email}?\n\nAll projects owned by this user will also be permanently deleted!`)) return;

			const csrfToken = getCsrfToken();
			btnDelete.disabled = true;
			try {
				const res = await fetch(`/admin/user/${userId}/delete`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'X-Csrf-Token': csrfToken
					},
					body: JSON.stringify({ _csrf: csrfToken })
				});
				const data = await res.json();
				if (data.success) {
					const row = document.getElementById(`user-row-${userId}`);
					if (row) {
						row.remove();
						updateStats();
					}
					showFlash('success', `User ${email} and their projects have been deleted.`);
				} else {
					showFlash('danger', data.error || 'Failed to delete user.');
				}
			} catch (err) {
				showFlash('danger', 'Error deleting user: ' + err.message);
			} finally {
				btnDelete.disabled = false;
			}
		}
	});

	// Handle Registration Form
	document.getElementById('register-form')?.addEventListener('submit', async function (e) {
		e.preventDefault();
		const input = document.getElementById('register-emails');
		const emails = input?.value || '';
		if (!emails.trim()) return;

		const btn = document.getElementById('btn-register');
		const spinner = document.getElementById('register-spinner');
		const csrfToken = getCsrfToken();

		btn.disabled = true;
		spinner?.classList.remove('d-none');

		try {
			const res = await fetch('/admin/register', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Csrf-Token': csrfToken
				},
				body: JSON.stringify({ emails, _csrf: csrfToken })
			});
			const data = await res.json();
			const resultsBox = document.getElementById('register-results');
			const resultsBody = document.getElementById('register-results-body');

			const items = data.results || (data.email ? [data] : []);

			if (items.length > 0) {
				resultsBody.innerHTML = '';
				items.forEach(item => {
					const tr = document.createElement('tr');
					if (item.success !== false) {
						const emailBadge = item.emailSent
							? '<span class="badge bg-success-subtle text-success border border-success-subtle ms-2"><span class="material-symbols me-1" style="font-size: 13px; vertical-align: text-top;">mark_email_read</span>Email Sent</span>'
							: (item.emailError ? `<span class="badge bg-warning-subtle text-dark border border-warning-subtle ms-2" title="${item.emailError}"><span class="material-symbols me-1" style="font-size: 13px; vertical-align: text-top;">mail_lock</span>Email Not Sent</span>` : '');
						tr.innerHTML = `
							<td>
								<div class="d-flex align-items-center flex-wrap">
									<strong>${item.email}</strong>
									${emailBadge}
								</div>
							</td>
							<td class="small font-monospace text-break">
								${item.setNewPasswordUrl ? `<a href="${item.setNewPasswordUrl}" target="_blank" class="text-decoration-none">${item.setNewPasswordUrl}</a>` : '<span class="text-muted">–</span>'}
							</td>
							<td>
								${item.setNewPasswordUrl ? `<button type="button" class="btn btn-sm btn-outline-primary btn-copy-link" data-url="${item.setNewPasswordUrl}">Copy Link</button>` : ''}
							</td>
						`;
					} else {
						tr.innerHTML = `
							<td><strong>${item.email}</strong></td>
							<td colspan="2" class="text-danger small">${item.error || 'Registration failed'}</td>
						`;
					}
					resultsBody.appendChild(tr);
				});
				resultsBox.classList.remove('d-none');
				if (input) input.value = '';

				const successfulCount = items.filter(r => r.success !== false).length;
				const emailSentCount = items.filter(r => r.success !== false && r.emailSent).length;
				let msg = `Registered ${successfulCount} user(s).`;
				if (emailSentCount > 0) {
					msg += ` Invitation email sent to ${emailSentCount} user(s).`;
				}
				msg += ` Share or copy the activation link(s) below:`;
				showFlash('success', msg, true);

				// Dynamically add new users to the table if they are not already listed
				const tbody = document.getElementById('users-tbody');
				items.forEach(item => {
					if (item.success !== false && item._id && !document.getElementById(`user-row-${item._id}`)) {
						const tr = document.createElement('tr');
						tr.id = `user-row-${item._id}`;
						tr.setAttribute('data-user-id', item._id);
						tr.setAttribute('data-email', item.email.toLowerCase());
						tr.setAttribute('data-name', '');
						tr.setAttribute('data-is-admin', 'false');
						tr.setAttribute('data-is-pending', 'true');
						tr.innerHTML = `
							<td>
								<div class="d-flex align-items-center">
									<div class="user-avatar me-2">${item.email[0].toUpperCase()}</div>
									<div><div class="fw-semibold">–</div></div>
								</div>
							</td>
							<td><span class="fw-medium user-email-text">${item.email}</span></td>
							<td><span class="badge bg-secondary bg-opacity-25 text-dark role-badge">User</span></td>
							<td><span class="badge bg-warning text-dark status-badge">Pending</span></td>
							<td class="text-center"><span class="badge bg-light text-dark border" title="0 owned">0</span></td>
							<td class="small text-muted">Just now</td>
							<td class="small text-muted">Never</td>
							<td class="text-end">
								<div class="btn-group btn-group-sm">
									<button class="btn btn-outline-secondary btn-reset-link" type="button" data-user-id="${item._id}" data-email="${item.email}" title="Generate activation / password reset link">
										<span class="material-symbols me-1">key</span>Link
									</button>
									<button class="btn btn-outline-secondary btn-toggle-admin" type="button" data-user-id="${item._id}" data-is-admin="false" title="Promote to admin">Make Admin</button>
									<button class="btn btn-outline-danger btn-delete-user" type="button" data-user-id="${item._id}" data-email="${item.email}" title="Delete user account">
										<span class="material-symbols">delete</span>
									</button>
								</div>
							</td>
						`;
						tbody.insertBefore(tr, tbody.firstChild);
					}
				});
				updateStats();
			} else {
				showFlash('danger', data.error || 'Failed to register users.');
			}
		} catch (err) {
			showFlash('danger', 'Error registering users: ' + err.message);
		} finally {
			btn.disabled = false;
			spinner?.classList.add('d-none');
		}
	});

	// Copy links from registration results table
	document.getElementById('register-results-body')?.addEventListener('click', function (e) {
		const btn = e.target.closest('.btn-copy-link');
		if (btn) {
			const url = btn.getAttribute('data-url');
			if (url) copyToClipboard(url, btn);
		}
	});

		updateStats();
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
