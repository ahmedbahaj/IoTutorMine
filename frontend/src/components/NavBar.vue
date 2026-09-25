<template>
  <nav class="navbar">
    <div class="navbar-inner container">
      <router-link to="/" class="navbar-brand">
        IoTutorMine
      </router-link>

      <div class="navbar-links">
        <router-link
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="nav-link"
          :class="{ 'nav-link--active': isActive(item) }"
          active-class=""
          exact-active-class=""
        >
          {{ item.label }}
        </router-link>
      </div>


      <button
        class="navbar-toggle"
        @click="menuOpen = !menuOpen"
        :aria-expanded="menuOpen"
        aria-controls="navbar-mobile-menu"
        aria-label="Toggle menu"
      >
        <svg v-if="!menuOpen" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        <svg v-else width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>

    <div
      id="navbar-mobile-menu"
      class="navbar-mobile"
      :class="{ open: menuOpen }"
      @click="menuOpen = false"
    >
      <router-link
        v-for="item in navItems"
        :key="item.to"
        :to="item.to"
        class="nav-link"
        :class="{ 'nav-link--active': isActive(item) }"
        active-class=""
        exact-active-class=""
      >
        {{ item.label }}
      </router-link>
    </div>
  </nav>
</template>

<script setup>
import { ref, watch } from 'vue'
import { useRoute } from 'vue-router'

const menuOpen = ref(false)

const navItems = [
  { to: '/', label: 'Home', exact: true },
  { to: '/my-extractions', label: 'My Extractions', exact: false },
  { to: '/extractions', label: 'All Extractions', exact: false },
  { to: '/research', label: 'Research', exact: false }
]

const route = useRoute()

// router-link's own active class matches on route records, so a top-level
// detail route like /my-extractions/:id would not light up /my-extractions.
// Matching on the path prefix keeps a section highlighted on its detail pages,
// while `exact` stops Home from matching everything.
function isActive(item) {
  const path = route.path
  return item.exact ? path === item.to : path === item.to || path.startsWith(`${item.to}/`)
}

// Close the mobile menu after navigating.
watch(() => route.fullPath, () => { menuOpen.value = false })
</script>

<style scoped>
.navbar {
  position: sticky;
  top: 0;
  z-index: 100;
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-border);
  height: var(--navbar-height);
}

.navbar-inner {
  display: flex;
  align-items: center;
  height: 100%;
  gap: var(--space-lg);
}

.navbar-brand {
  font-size: var(--font-size-lg);
  font-weight: 700;
  color: var(--color-text-primary);
  text-decoration: none;
  letter-spacing: -0.02em;
  flex-shrink: 0;
}

.navbar-brand:hover {
  text-decoration: none;
}

.navbar-links {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.nav-link {
  display: flex;
  align-items: center;
  padding: 0 12px;
  height: 100%;
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-text-secondary);
  text-decoration: none;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}

.nav-link:hover {
  color: var(--color-text-primary);
  text-decoration: none;
}

.nav-link--active {
  color: var(--color-accent);
  border-bottom-color: var(--color-accent);
}

.navbar-auth {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  padding: 6px 16px;
  font-size: var(--font-size-sm);
  font-weight: 500;
  border-radius: var(--radius-sm);
  border: none;
  text-decoration: none;
  transition: background 0.15s, color 0.15s;
}

.btn--ghost {
  color: var(--color-text-secondary);
  background: transparent;
}

.btn--ghost:hover {
  color: var(--color-text-primary);
  background: var(--color-surface-hover);
  text-decoration: none;
}

.btn--primary {
  color: #fff;
  background: var(--color-accent);
}

.btn--primary:hover {
  background: var(--color-accent-hover);
  text-decoration: none;
}

/* Mobile toggle */
.navbar-toggle {
  display: none;
  background: none;
  border: none;
  color: var(--color-text-secondary);
  padding: 4px;
}

.navbar-mobile {
  display: none;
}

@media (max-width: 640px) {
  .navbar-links,
  .navbar-auth {
    display: none;
  }

  .navbar-toggle {
    display: block;
    margin-left: auto;
  }

  .navbar-mobile {
    display: none;
    flex-direction: column;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    padding: var(--space-sm) var(--space-lg);
  }

  .navbar-mobile.open {
    display: flex;
  }

  .navbar-mobile .nav-link {
    height: auto;
    padding: 12px 0;
    border-bottom: 1px solid var(--color-border-light);
  }

  .navbar-mobile .nav-link:last-child {
    border-bottom: none;
  }

  .navbar-mobile .nav-link--active {
    color: var(--color-accent);
  }
}
</style>
