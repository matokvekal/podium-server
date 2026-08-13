import { Router } from "express";
import { requireAuth } from "../../middleware/requireAuth.js";
import { getMe, updateMe } from "./user.controller.js";

export const userRouter = Router();

userRouter.get("/me", requireAuth, getMe);
userRouter.patch("/me", requireAuth, updateMe);
