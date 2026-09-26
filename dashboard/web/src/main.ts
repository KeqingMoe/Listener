import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
const Overview = () => import("./views/OverviewView.vue");
const Wakes = () => import("./views/WakesView.vue");
const WakeDetail = () => import("./views/WakeDetailView.vue");
const Tools = () => import("./views/ToolsView.vue");
import "./styles/main.css";
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: Overview },
    { path: "/wakes", component: Wakes },
    { path: "/wakes/:groupId/:wakeId", component: WakeDetail },
    { path: "/tools", component: Tools },
  ],
});
createApp(App).use(router).mount("#app");
