<div align="center">

  <img src="overrides/brand/cloverleaf-icon.svg" alt="Cloverleaf Logo" width="128" height="128" />

  <h1>Cloverleaf</h1>

  <p>
    An enhanced, self-hosted collaborative LaTeX editor with custom branding,
    extended user activation workflows, email notifications, and streamlined deployment.
  </p>

<p>
  <a href="https://github.com/Partha11/overleaf-toolkit/stargazers">
    <img src="https://img.shields.io/github/stars/Partha11/overleaf-toolkit" alt="stars" />
  </a>
  <a href="https://github.com/Partha11/overleaf-toolkit/issues/">
    <img src="https://img.shields.io/github/issues/Partha11/overleaf-toolkit" alt="open issues" />
  </a>
  <a href="https://www.docker.com/">
    <img src="https://img.shields.io/badge/Docker-20.10+-2496ED.svg?logo=docker&logoColor=white" alt="Docker" />
  </a>
  <a href="https://nodejs.org/">
    <img src="https://img.shields.io/badge/Node.js-22+-339933.svg?logo=node.js&logoColor=white" alt="Node.js" />
  </a>
  <a href="https://www.gnu.org/licenses/agpl-3.0">
    <img src="https://img.shields.io/badge/License-AGPL%20v3-blue.svg" alt="License: AGPL v3" />
  </a>
</p>

<h4>
  <a href="#quick-start">Quick Start</a>
  <span> · </span>
  <a href="#about">About</a>
  <span> · </span>
  <a href="#key-enhancements">Features</a>
  <span> · </span>
  <a href="#configuration">Configuration</a>
  <span> · </span>
  <a href="https://github.com/Partha11/overleaf-toolkit/issues/">Report Bug</a>
</h4>

</div>

## About

**Cloverleaf** is an enhanced, self-hosted distribution of Overleaf Community Edition built on top of the containerized toolkit. It preserves full compatibility with the official Overleaf CE ecosystem while introducing refined branding, comprehensive administrative tooling, and quality-of-life enhancements for self-hosters and collaborative teams.

### Key Enhancements

- **Refined Branding & UI**: Custom Cloverleaf iconography, smooth editor-loading fill animation, redesigned header logo, and dynamic compile-status favicons (normal, compiling, compiled, error).
- **Advanced User Management**: Dedicated `/admin/user` dashboard with batch registration, project counts (owned vs. collaborated breakdown), admin privilege toggles, and account removal.
- **Automated Invitation Emails**: Automatic activation/welcome emails dispatched to newly registered users via SMTP (with graceful fallback direct activation links when mail transport is unavailable).
- **Flexible Reverse Proxy & Dual-Access Support**: Dynamic protocol and host detection enabling seamless simultaneous access via HTTPS domain names and direct HTTP IP addresses without cookie or session dropouts.
- **Editor Review Comments**: Restored review thread and messaging capabilities in the editor side panel.

## Quick Start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (v20.10+)
- [Docker Compose](https://docs.docker.com/compose/install/) (v2.0+)
- Git

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Partha11/overleaf-toolkit.git ./cloverleaf
   cd cloverleaf
   ```

2. **Initialize configuration:**
   ```bash
   bin/init
   ```
   This generates the local configuration files in `config/` and applies the custom Docker Compose overrides.

3. **Configure your instance:**
   Review and adjust settings in `config/overleaf.rc` and `config/variables.env`:
   ```bash
   nano config/overleaf.rc
   nano config/variables.env
   ```

4. **Start the containers:**
   ```bash
   bin/up -d
   ```

5. **Create the initial admin user:**
   Open `http://localhost` (or `http://your-server-ip:port`) in your browser to complete the launchpad wizard, or create an administrator directly from the command line:
   ```bash
   bin/docker-exec sharelatex node services/web/scripts/create-admin-user.js --email admin@example.com
   ```

## Configuration

### Mail / SMTP Setup

To enable automated invitation and password reset emails, configure your SMTP credentials in `config/variables.env`:

```env
OVERLEAF_EMAIL_FROM_ADDRESS=noreply@yourdomain.com
OVERLEAF_EMAIL_SMTP_HOST=smtp.resend.com
OVERLEAF_EMAIL_SMTP_PORT=587
OVERLEAF_EMAIL_SMTP_SECURE=false
OVERLEAF_EMAIL_SMTP_USER=resend
OVERLEAF_EMAIL_SMTP_PASS=re_your_api_key
```

### Reverse Proxy & SSL

When deploying behind Nginx or Traefik:

```env
OVERLEAF_BEHIND_PROXY=true
OVERLEAF_SECURE_COOKIE=auto
OVERLEAF_SITE_URL=https://cloverleaf.yourdomain.com
```

> [!TIP]
> Setting `OVERLEAF_SECURE_COOKIE=auto` ensures cookies adapt automatically—securing them over HTTPS connections while keeping direct HTTP IP access functional without login errors.

## Management Commands

The toolkit provides simple wrapper scripts in the `bin/` directory:

| Command | Description |
| :--- | :--- |
| `bin/up -d` | Start all Cloverleaf containers in detached mode |
| `bin/down` | Stop and remove active containers |
| `bin/doctor` | Run diagnostic checks on system requirements and configuration |
| `bin/logs` | View real-time container log output |
| `bin/docker-exec` | Execute a command inside the `sharelatex` web container |
| `bin/build-frontend` | Recompile frontend bundles with custom overrides and themes |

## Contributing

Contributions are welcome:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'Add my feature'`)
4. Push the branch (`git push origin feature/my-feature`)
5. Open a pull request

Bug reports and suggestions can be submitted via [GitHub Issues](https://github.com/Partha11/overleaf-toolkit/issues).

## Credits & Acknowledgements

- Special credit to **Sabbir Mahmud Afridi** for suggesting the name **Cloverleaf**.
- Cloverleaf is built upon and extends the official **[Overleaf Toolkit](https://github.com/overleaf/toolkit)** developed and maintained by [Overleaf](https://www.overleaf.com) (Digital Science / WriteLaTeX Ltd).

We express our gratitude to the Overleaf team and the open-source community for creating and supporting the foundational LaTeX collaborative editor ecosystem.

- **Original Repository:** [github.com/overleaf/toolkit](https://github.com/overleaf/toolkit)
- **Overleaf Community Edition:** [github.com/overleaf/overleaf](https://github.com/overleaf/overleaf)

## License

Distributed under the GNU Affero General Public License v3.0. See [LICENSE](LICENSE) for details.
