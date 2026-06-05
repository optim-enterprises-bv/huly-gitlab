// Set allowed GitLab hosts for all tests so url-validation.ts accepts test hostnames
process.env.GITLAB_ALLOWED_HOSTS = 'gitlab.com,gitlab.test,gitlab.oauth.test,gitlab.at.test,gitlab.refresh.test'
