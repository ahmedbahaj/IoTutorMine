import { createRouter, createWebHistory } from 'vue-router'
import HomePage from '../views/HomePage.vue'
import VideoDetailPage from '../views/VideoDetailPage.vue'

const routes = [
  { path: '/', name: 'Home', component: HomePage },
  { path: '/video/:id', name: 'VideoDetail', component: VideoDetailPage, props: true },

  // Personal history, stored in this browser only.
  {
    path: '/my-extractions',
    name: 'MyExtractions',
    component: () => import('../views/MyExtractionsPage.vue')
  },
  {
    path: '/my-extractions/:id',
    name: 'MyExtractionDetail',
    component: () => import('../views/ExtractionDetailPage.vue'),
    props: { mode: 'local' }
  },

  // Shared public library.
  {
    path: '/extractions',
    name: 'AllExtractions',
    component: () => import('../views/AllExtractionsPage.vue')
  },
  {
    path: '/extractions/:videoId',
    name: 'SharedExtractionDetail',
    component: () => import('../views/ExtractionDetailPage.vue'),
    props: { mode: 'shared' }
  },

  // Frontend-only informational page: the published method, benchmark and
  // artifacts. No backend, database or model calls.
  {
    path: '/research',
    name: 'Research',
    component: () => import('../views/ResearchPage.vue')
  },

  { path: '/:pathMatch(.*)*', redirect: '/' }
]

const router = createRouter({
  history: createWebHistory('/IoTutorMine/'),
  routes,
  scrollBehavior() {
    return { top: 0 }
  }
})

export default router
