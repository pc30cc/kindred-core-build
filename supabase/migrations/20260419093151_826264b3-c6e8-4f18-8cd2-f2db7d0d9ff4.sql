-- Add 'ai' as a distinct sender_type so AI auto-replies can be filtered
-- separately from human agent messages and the existing generic 'bot' value.
ALTER TYPE public.sender_type ADD VALUE IF NOT EXISTS 'ai';