import { configureStore } from '@reduxjs/toolkit';
import functionReducer from './functionSlice';

export const store = configureStore({
  reducer: {
    functions: functionReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
