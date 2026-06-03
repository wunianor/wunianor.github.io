(() => {
  'use strict'

  const THEME_KEY = 'wunianor-theme'
  const DEFAULT_THEME = 'light'

  const getStoredTheme = () => {
    const stored = localStorage.getItem(THEME_KEY)
    return stored === 'light' || stored === 'dark' ? stored : null
  }

  const getTheme = () => getStoredTheme() || DEFAULT_THEME

  const setTheme = (theme) => {
    document.documentElement.setAttribute('data-bs-theme', theme)
  }

  const setStoredTheme = (theme) => {
    localStorage.setItem(THEME_KEY, theme)
  }

  const updateToggleUI = (theme) => {
    const btn = document.getElementById('wunianor-theme-toggle')
    if (!btn) return

    const sunIcon = btn.querySelector('.theme-icon-sun')
    const moonIcon = btn.querySelector('.theme-icon-moon')
    if (!sunIcon || !moonIcon) return

    if (theme === 'light') {
      sunIcon.classList.add('d-none')
      moonIcon.classList.remove('d-none')
      btn.setAttribute('aria-label', '切换到深色主题')
    } else {
      sunIcon.classList.remove('d-none')
      moonIcon.classList.add('d-none')
      btn.setAttribute('aria-label', '切换到浅色主题')
    }
  }

  setTheme(getTheme())
  updateToggleUI(getTheme())

  window.addEventListener('DOMContentLoaded', () => {
    const theme = getTheme()
    updateToggleUI(theme)

    const btn = document.getElementById('wunianor-theme-toggle')
    if (!btn) return

    btn.addEventListener('click', () => {
      const next = getTheme() === 'light' ? 'dark' : 'light'
      setStoredTheme(next)
      setTheme(next)
      updateToggleUI(next)
    })
  })
})()
