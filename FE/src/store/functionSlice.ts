import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { Function, functionsApi } from '../services/api';

interface FunctionState {
  functions: Function[];
  currentFunction: Function | null;
  loading: boolean;
  error: string | null;
}

const initialState: FunctionState = {
  functions: [],
  currentFunction: null,
  loading: false,
  error: null,
};

export const fetchFunctions = createAsyncThunk(
  'functions/fetchAll',
  async () => {
    const response = await functionsApi.getAllFunctions();
    return response.data;
  }
);

export const createFunction = createAsyncThunk(
  'functions/create',
  async (functionData: Partial<Function>) => {
    const response = await functionsApi.createFunction(functionData);
    return response.data;
  }
);

export const updateFunction = createAsyncThunk(
  'functions/update',
  async ({ id, data }: { id: string; data: Partial<Function> }) => {
    const response = await functionsApi.updateFunction(id, data);
    return response.data;
  }
);

export const deleteFunction = createAsyncThunk(
  'functions/delete',
  async (id: string) => {
    await functionsApi.deleteFunction(id);
    return id;
  }
);

const functionSlice = createSlice({
  name: 'functions',
  initialState,
  reducers: {
    setCurrentFunction: (state, action) => {
      state.currentFunction = action.payload;
    },
    clearCurrentFunction: (state) => {
      state.currentFunction = null;
    },
  },
  extraReducers: (builder) => {
    builder
      // Fetch functions
      .addCase(fetchFunctions.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchFunctions.fulfilled, (state, action) => {
        state.loading = false;
        state.functions = action.payload;
      })
      .addCase(fetchFunctions.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message || 'Failed to fetch functions';
      })
      // Create function
      .addCase(createFunction.fulfilled, (state, action) => {
        state.functions.push(action.payload);
      })
      // Update function
      .addCase(updateFunction.fulfilled, (state, action) => {
        const index = state.functions.findIndex(f => f.id === action.payload.id);
        if (index !== -1) {
          state.functions[index] = action.payload;
        }
      })
      // Delete function
      .addCase(deleteFunction.fulfilled, (state, action) => {
        state.functions = state.functions.filter(f => f.id !== action.payload);
      });
  },
});

export const { setCurrentFunction, clearCurrentFunction } = functionSlice.actions;
export default functionSlice.reducer;
